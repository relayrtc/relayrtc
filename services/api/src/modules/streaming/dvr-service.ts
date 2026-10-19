import { sql } from "drizzle-orm";
import type { RelayKitDatabase } from "@relayrtc/database";
import { z } from "zod";
import { dvrPolicySchema, rollingBufferPolicySchema } from "@relayrtc/validation";
import type { DvrPlayback } from "@relayrtc/types";
import { signStreamingGrant } from "@relayrtc/protocol/streaming-control";
import { id, conflict, type Transaction, type StreamRow } from "./repository.js";
import { getRecording, recordingRowSchema } from "./recording-service.js";
import type { StreamingConfig } from "./config.js";
import {
  boundedMaintenanceTransaction,
  maintenanceBatch,
  maintenanceTransaction,
  type MaintenanceRunner,
} from "./maintenance.js";

export async function dvrEvent(
  db: Transaction,
  windowId: string,
  type: string,
  details: Record<string, unknown> = {},
) {
  const [w] = await db.execute(
    sql`UPDATE dvr_window SET event_sequence=event_sequence+1,last_event_at=now() WHERE id=${windowId} RETURNING *`,
  );
  if (!w) return;
  const r = await getRecording(db, String(w.recording_id)),
    eventId = id("event"),
    occurredAt = new Date().toISOString();
  const body = JSON.stringify({
    id: eventId,
    type,
    projectId: r.project_id,
    environmentId: r.environment_id,
    occurredAt,
    data: {
      streamId: r.stream_id,
      broadcastId: r.broadcast_id,
      windowId,
      state: w.state,
      sequence: Number(w.event_sequence),
      actor: { type: "SYSTEM", id: "dvr-runtime", name: "DVR runtime" },
      ...details,
    },
  });
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${r.project_id},${r.environment_id},${type},${occurredAt},${body}::jsonb,${body})`,
  );
}

/** One capture/object owner; clips and DVR extend its required retention together. */
export async function effectiveBufferPolicy(
  db: Transaction,
  streamId: string,
  recordingId: string,
) {
  const [clip] = await db.execute(
    sql`SELECT policy FROM stream_buffer_policy WHERE stream_id=${streamId}`,
  );
  const c = clip ? rollingBufferPolicySchema.parse(clip.policy) : null;
  const [window] = await db.execute(
    sql`SELECT policy FROM dvr_window WHERE recording_id=${recordingId} AND state<>'disabled' AND (expires_at IS NULL OR expires_at>now())`,
  );
  const d = window ? dvrPolicySchema.parse(window.policy) : null;
  return {
    enabled: c?.enabled === true || d !== null,
    durationSeconds: Math.max(c?.enabled ? c.durationSeconds : 0, d?.durationSeconds ?? 0),
    maxBytes: Math.max(c?.enabled ? c.maxBytes : 0, d?.maxBytes ?? 0),
  };
}

export async function drainDvrWindow(
  db: Transaction,
  windowId: string,
  streamId: string,
  seconds: number,
) {
  const data = await dvrWindowData(db, streamId, undefined, windowId, true);
  if (data?.window.state !== "active") return;
  const expiresAt = new Date(Date.now() + seconds * 1000).toISOString(),
    end = Number(data.segments.at(-1)?.position ?? -1);
  await db.execute(
    sql`UPDATE dvr_window SET state='draining',expires_at=${expiresAt},end_position=${end} WHERE id=${windowId}`,
  );
  // Freeze exactly the advertised tail, even if a shared clip buffer continues capturing.
  if (data.segments.length)
    await db.execute(
      sql`INSERT INTO dvr_segment_pin(recording_id,position,expires_at) VALUES ${sql.join(
        data.segments.map(
          (segment) => sql`(${data.r.id},${Number(segment.position)},${expiresAt})`,
        ),
        sql`, `,
      )} ON CONFLICT(recording_id,position) DO UPDATE SET expires_at=greatest(dvr_segment_pin.expires_at,excluded.expires_at)`,
    );
}

export async function syncDvrWindows(
  database: RelayKitDatabase,
  config: StreamingConfig,
  run: MaintenanceRunner,
) {
  await run("dvr:expired-pins", () =>
    maintenanceTransaction(database, "dvr:expired-pins", async (db) => {
      await db.execute(sql`DELETE FROM dvr_segment_pin WHERE expires_at<=now()`);
    }),
  );
  const candidates = config.dvrEnabled
    ? await database.execute(
        sql`SELECT r.id FROM recording r JOIN stream_dvr_policy p ON p.stream_id=r.stream_id JOIN streaming_stream s ON s.id=r.stream_id JOIN broadcast_run b ON b.id=r.broadcast_id WHERE r.kind='buffer' AND r.state IN ('queued','recording') AND r.stop_requested=false AND p.policy->>'enabled'='true' AND s.status='active' AND b.desired_state='running' AND NOT EXISTS(SELECT 1 FROM dvr_window w WHERE w.recording_id=r.id) ORDER BY r.created_at LIMIT 32`,
      )
    : [];
  await maintenanceBatch(candidates, (row) =>
    run(`dvr:admit:${String(row.id)}`, () =>
      maintenanceTransaction(database, `dvr:admit:${String(row.id)}`, async (db) => {
        const [current] = await db.execute(
          sql`SELECT r.id,p.policy,p.version FROM recording r JOIN stream_dvr_policy p ON p.stream_id=r.stream_id JOIN streaming_stream s ON s.id=r.stream_id JOIN broadcast_run b ON b.id=r.broadcast_id WHERE r.id=${String(row.id)} AND r.kind='buffer' AND r.state IN ('queued','recording') AND r.stop_requested=false AND p.policy->>'enabled'='true' AND s.status='active' AND b.desired_state='running' FOR UPDATE OF r SKIP LOCKED`,
        );
        if (!current) return;
        const policy = dvrPolicySchema.parse(current.policy),
          windowId = id("dvr");
        const inserted = await db.execute(
          sql`INSERT INTO dvr_window(id,recording_id,policy,policy_version) VALUES(${windowId},${String(current.id)},${JSON.stringify(policy)}::jsonb,${Number(current.version)}) ON CONFLICT DO NOTHING RETURNING id`,
        );
        if (inserted.length) await dvrEvent(db, windowId, "dvr.enabled");
      }),
    ),
  );
  const windows = await database.execute(
    sql`SELECT id,recording_id FROM dvr_window WHERE state<>'disabled' ORDER BY id LIMIT 100`,
  );
  await maintenanceBatch(windows, (window) =>
    run(`dvr:window:${String(window.id)}`, async () => {
      try {
        await maintenanceTransaction(database, `dvr:window:${String(window.id)}`, async (db) => {
          await syncDvrWindow(db, String(window.id), config);
          await db.execute(
            sql`UPDATE recording SET last_error=NULL WHERE id=${String(window.recording_id)} AND last_error='DVR_MAINTENANCE_RETRY'`,
          );
        });
      } catch (error) {
        await boundedMaintenanceTransaction(database, (db) =>
          db.execute(
            sql`UPDATE recording SET last_error='DVR_MAINTENANCE_RETRY' WHERE id=${String(window.recording_id)} AND (last_error IS NULL OR last_error='DVR_MAINTENANCE_RETRY')`,
          ),
        );
        throw error;
      }
    }),
  );
  await run("dvr:cleanup", () =>
    maintenanceTransaction(database, "dvr:cleanup", async (db) => {
      await db.execute(
        sql`UPDATE recording r SET stop_requested=true WHERE r.kind='buffer' AND r.stop_requested=false AND EXISTS(SELECT 1 FROM dvr_window w WHERE w.recording_id=r.id AND w.state<>'active') AND NOT EXISTS(SELECT 1 FROM stream_buffer_policy p WHERE p.stream_id=r.stream_id AND p.policy->>'enabled'='true')`,
      );
      await db.execute(
        sql`DELETE FROM dvr_delivery_usage WHERE id IN (SELECT id FROM dvr_delivery_usage WHERE created_at<now()-interval '90 days' LIMIT 1000)`,
      );
    }),
  );
}

async function syncDvrWindow(db: Transaction, windowId: string, config: StreamingConfig) {
  const [w] = await db.execute(
    sql`SELECT w.*,r.state AS recording_state,r.stop_requested,r.stream_id,b.desired_state,b.state AS run_state,s.status AS owner_status,p.policy AS desired_policy FROM dvr_window w JOIN recording r ON r.id=w.recording_id JOIN streaming_stream s ON s.id=r.stream_id JOIN broadcast_run b ON b.id=r.broadcast_id LEFT JOIN stream_dvr_policy p ON p.stream_id=r.stream_id WHERE w.id=${windowId} AND w.state<>'disabled' FOR UPDATE OF w SKIP LOCKED`,
  );
  if (!w) return;
  const desired = w.desired_policy ? dvrPolicySchema.parse(w.desired_policy) : null;
  const policy = dvrPolicySchema.parse(w.policy);
  if (
    w.state === "active" &&
    (!config.dvrEnabled ||
      !desired?.enabled ||
      w.owner_status !== "active" ||
      w.desired_state !== "running" ||
      w.stop_requested ||
      !["queued", "recording"].includes(String(w.recording_state)) ||
      ["stopping", "stopped", "failed"].includes(String(w.run_state)))
  ) {
    const seconds =
      w.owner_status !== "active" || !config.dvrEnabled ? 0 : policy.endedRetentionSeconds;
    await drainDvrWindow(db, String(w.id), String(w.stream_id), seconds);
    w.state = "draining";
  }
  const [expired] = await db.execute(
    sql`UPDATE dvr_window SET state='disabled' WHERE id=${String(w.id)} AND expires_at<=now() RETURNING id`,
  );
  if (expired) {
    await dvrEvent(db, String(w.id), "dvr.disabled");
    w.state = "disabled";
  }
  if (
    w.state === "active" &&
    (!w.last_event_at || z.coerce.date().parse(w.last_event_at).getTime() < Date.now() - 30000)
  ) {
    const [range] = await db.execute(
      sql`SELECT min(position)::int AS first,max(position)::int AS last FROM recording_segment WHERE recording_id=${String(w.recording_id)}`,
    );
    if (
      range?.first != null &&
      range.last != null &&
      (Number(range?.first) !== Number(w.last_start) || Number(range?.last) !== Number(w.last_end))
    ) {
      const first = Number(range?.first),
        last = Number(range?.last),
        previous = Number(w.last_start);
      await db.execute(
        sql`UPDATE dvr_window SET last_start=${first},last_end=${last} WHERE id=${String(w.id)}`,
      );
      await dvrEvent(db, String(w.id), "dvr.window_changed", {
        firstSequence: first,
        lastSequence: last,
      });
      if (previous >= 0 && first > previous)
        await dvrEvent(db, String(w.id), "dvr.segment_evicted", {
          beforeSequence: first,
          count: first - previous,
        });
    }
  }
}

export async function dvrWindowData(
  db: Transaction,
  streamId: string,
  broadcastId?: string,
  windowId?: string,
  lock = false,
  includeSegments = true,
) {
  const [window] = await db.execute(
    sql`SELECT w.* FROM dvr_window w JOIN recording r ON r.id=w.recording_id WHERE r.stream_id=${streamId} ${broadcastId ? sql`AND r.broadcast_id=${broadcastId}` : sql``} ${windowId ? sql`AND w.id=${windowId}` : sql``} ORDER BY r.created_at DESC LIMIT 1 ${lock ? sql`FOR UPDATE OF w` : sql``}`,
  );
  if (!window) return null;
  const r = await getRecording(db, String(window.recording_id), false, lock);
  const policy = dvrPolicySchema.parse(window.policy);
  const expired =
    window.state === "disabled" ||
    (window.expires_at !== null &&
      z.coerce.date().parse(window.expires_at).getTime() <= Date.now()) ||
    ["deleting", "deleted", "failed"].includes(r.state);
  const all =
    expired || !includeSegments
      ? []
      : await db.execute(
          sql`SELECT s.*,coalesce(o.size_bytes,0)+coalesce(a.size_bytes,0) AS bytes FROM recording_segment s JOIN recording_object o ON o.recording_id=s.recording_id AND o.name=s.name LEFT JOIN recording_object a ON a.recording_id=s.recording_id AND a.name=s.audio_name WHERE s.recording_id=${r.id} AND (${window.end_position === null} OR s.position<=${Number(window.end_position ?? -1)}) ORDER BY s.position DESC LIMIT 2000`,
        );
  const segments: Record<string, unknown>[] = [];
  let bytes = 0;
  const edge = Number(all[0]?.media_start_seconds ?? 0) + Number(all[0]?.duration_seconds ?? 0);
  for (const s of all) {
    // A fixed HLS target duration is required for the entire playlist lifecycle.
    if (
      Number(s.duration_seconds) > 6 ||
      (s.audio_duration_seconds !== null && Number(s.audio_duration_seconds) > 6)
    )
      break;
    if (segments.length && !!s.audio_name !== !!segments[0]?.audio_name) break;
    if (
      Number(s.media_start_seconds) < edge - policy.durationSeconds ||
      bytes + Number(s.bytes) > policy.maxBytes * 0.7
    )
      break;
    // Eviction may leave clip-pinned islands. Only advertise a continuous tail.
    if (
      segments.length &&
      Number(s.position) !== Number(segments[segments.length - 1]?.position) - 1
    )
      break;
    bytes += Number(s.bytes);
    segments.push(s);
  }
  segments.reverse();
  return { window, r, policy, segments, expired };
}

export async function dvrPlayback(
  db: Transaction,
  stream: StreamRow,
  config: StreamingConfig,
  broadcastId?: string,
): Promise<DvrPlayback> {
  const data = await dvrWindowData(db, stream.id, broadcastId);
  const first = data?.segments[0],
    last = data?.segments.at(-1);
  const [latest] = data
    ? []
    : await db.execute(
        sql`SELECT * FROM recording WHERE stream_id=${stream.id} AND kind='buffer' ${broadcastId ? sql`AND broadcast_id=${broadcastId}` : sql``} ORDER BY created_at DESC LIMIT 1`,
      );
  const capture = data?.r ?? (latest ? recordingRowSchema.parse(latest) : null);
  const [configured] = await db.execute(
    sql`SELECT policy FROM stream_dvr_policy WHERE stream_id=${stream.id}`,
  );
  return {
    streamId: stream.id,
    capture: {
      state:
        capture?.state ??
        (config.dvrEnabled && configured?.policy && dvrPolicySchema.parse(configured.policy).enabled
          ? "waiting"
          : "not_configured"),
      lastError: capture?.last_error ?? null,
      retrying: Boolean(
        capture?.last_error &&
        !["failed", "deleting", "deleted"].includes(capture.state) &&
        (capture.last_error === "DVR_MAINTENANCE_RETRY" || capture.state !== "ready"),
      ),
    },
    broadcastId: data?.r.broadcast_id ?? broadcastId ?? null,
    windowId: data ? String(data.window.id) : null,
    sourceSessionId: data ? String(data.window.id) : null,
    generation: data ? Number(data.window.policy_version) : null,
    state:
      !config.dvrEnabled || !data || data.expired
        ? "unavailable"
        : !first
          ? "starting"
          : data.window.state === "draining"
            ? "ended"
            : "live",
    startSeconds: first ? Number(first.media_start_seconds) : null,
    endSeconds: last ? Number(last.media_start_seconds) + Number(last.duration_seconds) : null,
    wallStart: first?.program_date_time
      ? z.coerce.date().parse(first.program_date_time).toISOString()
      : null,
    wallEnd: last?.program_date_time
      ? new Date(
          z.coerce.date().parse(last.program_date_time).getTime() +
            Number(last.duration_seconds) * 1000,
        ).toISOString()
      : null,
    discontinuities:
      data?.segments.filter((s) => s.discontinuity).map((s) => Number(s.media_start_seconds)) ?? [],
    expiresAt: data?.window.expires_at
      ? z.coerce.date().parse(data.window.expires_at).toISOString()
      : null,
    policyVersion: data ? Number(data.window.policy_version) : null,
    storedBytes: data?.r.stored_bytes ?? 0,
    storageByteSeconds: data?.r.storage_byte_seconds ?? 0,
    deliveredBytes: Number(data?.window.delivered_bytes ?? 0),
    storageAccounting: "shared-buffer; already metered by recording",
    grantRequired: true,
    renewal: "POST /v1/streams/{streamId}/playback-grants (mode=dvr, broadcastId)",
    delivery: "rolling-hls-fmp4",
    limits: {
      maxBuffers: config.maxBuffers,
      maxBuffersPerEnvironment: config.maxBuffersPerEnvironment,
    },
  };
}
export async function dvrGrant(
  db: Transaction,
  stream: StreamRow,
  config: StreamingConfig,
  ttl: number,
  broadcastId?: string,
) {
  const data = await dvrWindowData(db, stream.id, broadcastId);
  if (!config.dvrEnabled || !data || data.expired || !data.segments.length)
    throw conflict("DVR_WINDOW_UNAVAILABLE", "No retained DVR media is available for this run.");
  const seconds = Math.min(
    ttl,
    data.window.expires_at
      ? Math.max(
          0,
          Math.floor((z.coerce.date().parse(data.window.expires_at).getTime() - Date.now()) / 1000),
        )
      : ttl,
  );
  if (seconds < 1) throw conflict("DVR_WINDOW_EXPIRED", "This run's DVR window has expired.");
  const token = signStreamingGrant(
    config.secret,
    {
      aud: "streaming-playback",
      sub: id("viewer"),
      streamId: stream.id,
      sessionId: String(data.window.id),
      action: "dvr",
      generation: stream.playbackEpoch,
    },
    seconds,
  );
  return {
    token,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    url: `${config.publicOrigin}/v1/dvr/${stream.id}/${String(data.window.id)}/index.m3u8?token=${encodeURIComponent(token)}`,
  };
}
