import { effectiveBufferPolicy, syncDvrWindows } from "./dvr-service.js";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { ClipResource } from "@relayrtc/types";
import { createClipSchema, recordingPolicySchema } from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getRecording,
  recordingRowSchema,
  setRecordingState,
  deleteRecording,
} from "./recording-service.js";
import {
  getStream,
  id,
  conflict,
  missing,
  type Transaction,
  type StreamRow,
} from "./repository.js";
import type { StreamingConfig } from "./config.js";
import { StreamingStore } from "./store.js";

export const clipRowSchema = z.object({
  id: z.string(),
  source_recording_id: z.string(),
  recording_id: z.string(),
  label: z.string(),
  cut_mode: z.enum(["keyframe", "precise"]),
  requested_start_seconds: z.coerce.number(),
  requested_end_seconds: z.coerce.number(),
  resolved_start_seconds: z.coerce.number(),
  resolved_end_seconds: z.coerce.number(),
  published: z.boolean(),
  prepared: z.boolean(),
});
export async function getClip(db: Transaction, key: string): Promise<ClipResource> {
  const [row] = await db.execute(sql`SELECT * FROM clip_request WHERE id=${key}`);
  if (!row) throw missing();
  const c = clipRowSchema.parse(row),
    r = await getRecording(db, c.recording_id);
  return {
    id: c.id,
    streamId: r.stream_id,
    broadcastId: r.broadcast_id,
    sourceRecordingId: c.source_recording_id,
    recordingId: r.id,
    assetId: r.asset_id,
    label: c.label,
    state: r.state === "finalizing" ? "rendering" : r.state === "recording" ? "queued" : r.state,
    cutMode: c.cut_mode,
    requestedStartSeconds: c.requested_start_seconds,
    requestedEndSeconds: c.requested_end_seconds,
    resolvedStartSeconds: c.resolved_start_seconds,
    resolvedEndSeconds: c.resolved_end_seconds,
    durationSeconds: r.duration_seconds,
    published: c.published,
    lastError: r.last_error,
    storedBytes: r.stored_bytes,
    processingSeconds: r.processing_seconds,
    storageByteSeconds: r.storage_byte_seconds,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at?.toISOString() ?? null,
  };
}
export async function clipEvent(db: Transaction, recordingId: string, type: string) {
  const [c] = await db.execute(sql`SELECT id FROM clip_request WHERE recording_id=${recordingId}`);
  if (!c) return;
  const r = await getRecording(db, recordingId),
    eventId = id("event");
  const [sequence] = await db.execute(
    sql`UPDATE recording SET event_sequence=event_sequence+1 WHERE id=${r.id} RETURNING event_sequence`,
  );
  const occurredAt = new Date().toISOString();
  const body = JSON.stringify({
    id: eventId,
    type,
    projectId: r.project_id,
    environmentId: r.environment_id,
    occurredAt,
    data: {
      clipId: c.id,
      streamId: r.stream_id,
      broadcastId: r.broadcast_id,
      recordingId: r.id,
      assetId: r.asset_id,
      state: r.state === "finalizing" ? "rendering" : r.state,
      sequence: Number(sequence?.event_sequence),
      actor: { type: "SYSTEM", id: "clip-runtime", name: "Clip runtime" },
    },
  });
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${r.project_id},${r.environment_id},${type},${occurredAt},${body}::jsonb,${body})`,
  );
}
export async function clipWindows(db: Transaction, streamId: string) {
  const rows = await db.execute(
    sql`SELECT r.id,r.broadcast_id,r.kind,r.state,r.stored_bytes,min(s.media_start_seconds)::float8 AS start,max(s.media_start_seconds+s.duration_seconds)::float8 AS finish,min(s.program_date_time) AS wall_start,max(s.program_date_time+make_interval(secs=>s.duration_seconds)) AS wall_end FROM recording r JOIN recording_segment s ON s.recording_id=r.id WHERE r.stream_id=${streamId} AND r.kind<>'clip' AND r.state IN ('recording','finalizing','ready') GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    recordingId: String(r.id),
    broadcastId: String(r.broadcast_id),
    kind: r.kind as "recording" | "buffer",
    state: String(r.state),
    startSeconds: Number(r.start),
    endSeconds: Number(r.finish),
    wallStart: r.wall_start ? z.coerce.date().parse(r.wall_start).toISOString() : null,
    wallEnd: r.wall_end ? z.coerce.date().parse(r.wall_end).toISOString() : null,
    storedBytes: Number(r.stored_bytes),
  }));
}
export async function createClip(
  db: Transaction,
  stream: StreamRow,
  input: z.infer<typeof createClipSchema>,
  config: StreamingConfig,
) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(810038)`);
  const source = await getRecording(db, input.recordingId, false, true);
  if (source.stream_id !== stream.id || source.kind === "clip") throw missing();
  if (
    !["recording", "finalizing", "ready"].includes(source.state) ||
    (source.expires_at && source.expires_at.getTime() <= Date.now())
  )
    throw conflict("CLIP_SOURCE_UNAVAILABLE", "Choose a retained recording or live buffer.");
  const [count] = await db.execute(
    sql`SELECT count(*) FILTER(WHERE r.state IN ('queued','finalizing'))::int AS active,count(*) FILTER(WHERE r.environment_id=${stream.environmentId} AND c.created_at>now()-interval '1 minute')::int AS recent FROM clip_request c JOIN recording r ON r.id=c.recording_id`,
  );
  if (
    Number(count?.active) >= config.maxClipJobs ||
    Number(count?.recent) >= config.maxClipsPerMinute
  )
    throw conflict("CLIP_CAPACITY", "Clip processing or request capacity is full.");
  const segments = await db.execute(
    sql`SELECT * FROM recording_segment WHERE recording_id=${source.id} ORDER BY position`,
  );
  if (!segments.length) throw conflict("CLIP_RANGE_MISSING", "No retained media is available.");
  const first = Number(segments[0]?.media_start_seconds),
    last = segments[segments.length - 1];
  const end = Number(last?.media_start_seconds) + Number(last?.duration_seconds);
  let start: number, finish: number;
  if (input.interval.kind === "last") {
    finish = end;
    start = end - input.interval.seconds;
  } else if (input.interval.kind === "media") {
    start = input.interval.startSeconds;
    finish = input.interval.endSeconds;
  } else {
    const resolve = (instant: string, ending: boolean) => {
      const ms = Date.parse(instant);
      const matches = segments.filter(
        (s) =>
          s.program_date_time &&
          (ending
            ? ms > z.coerce.date().parse(s.program_date_time).getTime()
            : ms >= z.coerce.date().parse(s.program_date_time).getTime()) &&
          (ending
            ? ms <=
              z.coerce.date().parse(s.program_date_time).getTime() +
                Number(s.duration_seconds) * 1000
            : ms <
              z.coerce.date().parse(s.program_date_time).getTime() +
                Number(s.duration_seconds) * 1000),
      );
      if (matches.length !== 1)
        throw conflict(
          "CLIP_WALL_TIME_AMBIGUOUS",
          "Wall time is missing or ambiguous; select a media interval.",
        );
      const s = matches[0];
      if (!s) throw missing();
      return (
        Number(s.media_start_seconds) +
        (ms - z.coerce.date().parse(s.program_date_time).getTime()) / 1000
      );
    };
    start = resolve(input.interval.start, false);
    finish = resolve(input.interval.end, true);
  }
  if (finish <= start || finish - start > config.maxClipDurationSeconds)
    throw conflict(
      "CLIP_DURATION_LIMIT",
      "Select a positive interval within the clip duration limit.",
    );
  if (start < first || finish > end)
    throw conflict("CLIP_RANGE_EXPIRED", "The requested interval is outside the retained window.");
  const selected = segments.filter(
    (s) =>
      Number(s.media_start_seconds) < finish &&
      Number(s.media_start_seconds) + Number(s.duration_seconds) > start,
  );
  if (
    !selected.length ||
    selected.some(
      (s, i) =>
        i > 0 &&
        (s.discontinuity === true ||
          s.session_id !== selected[i - 1]?.session_id ||
          s.generation !== selected[i - 1]?.generation ||
          Math.abs(
            Number(s.media_start_seconds) -
              Number(selected[i - 1]?.media_start_seconds) -
              Number(selected[i - 1]?.duration_seconds),
          ) > 0.05),
    )
  )
    throw conflict(
      "CLIP_RANGE_DISCONTINUOUS",
      "Select an interval within one continuous source generation.",
    );
  const resolvedStart = Number(selected[0]?.media_start_seconds),
    tail = selected[selected.length - 1],
    resolvedEnd = Number(tail?.media_start_seconds) + Number(tail?.duration_seconds);
  if (!tail) throw missing();
  const policy = recordingPolicySchema.parse({
    consentAcknowledged: true,
    allowPartial: false,
    region: config.s3Region,
    exportMp4: true,
    retentionSeconds: input.retentionSeconds,
  });
  const backing = id("recording"),
    clipId = id("clip");
  await db.execute(
    sql`INSERT INTO recording(id,kind,stream_id,broadcast_id,asset_id,organization_id,project_id,environment_id,policy,duration_seconds,stop_requested,expires_at) VALUES(${backing},'clip',${stream.id},${source.broadcast_id},${id("asset")},${stream.organizationId},${stream.projectId},${stream.environmentId},${JSON.stringify(policy)}::jsonb,${input.cutMode === "precise" ? finish - start : resolvedEnd - resolvedStart},true,now()+make_interval(secs=>${input.retentionSeconds}))`,
  );
  await db.execute(
    sql`INSERT INTO clip_request(id,source_recording_id,recording_id,label,cut_mode,requested_start_seconds,requested_end_seconds,resolved_start_seconds,resolved_end_seconds) VALUES(${clipId},${source.id},${backing},${input.label},${input.cutMode},${start},${finish},${resolvedStart},${resolvedEnd})`,
  );
  for (const s of selected)
    await db.execute(
      sql`INSERT INTO clip_segment_pin(clip_id,recording_id,position) VALUES(${clipId},${source.id},${Number(s.position)})`,
    );
  await clipEvent(db, backing, "clip.requested");
  return getClip(db, clipId);
}

export function registerClipMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  const store = new StreamingStore(config);
  let running: Promise<void> | undefined, evicting: Promise<void> | undefined;
  const tick = async () => {
    await database.transaction(async (db) => {
      const [lock] = await db.execute(sql`SELECT pg_try_advisory_xact_lock(810039) AS ok`);
      if (!lock?.ok) return;
      // Automatically retain a bounded buffer for each opted-in running broadcast.
      const policies = await db.execute(
        sql`SELECT s.id AS stream_id,b.id AS broadcast_id FROM streaming_stream s JOIN broadcast_run b ON b.stream_id=s.id LEFT JOIN stream_buffer_policy p ON p.stream_id=s.id LEFT JOIN stream_dvr_policy d ON d.stream_id=s.id WHERE (p.policy->>'enabled'='true' OR (${config.dvrEnabled} AND d.policy->>'enabled'='true')) AND s.status='active' AND b.desired_state='running' AND b.state IN ('live','reconnecting') AND NOT EXISTS(SELECT 1 FROM recording r WHERE r.broadcast_id=b.id AND r.kind='buffer') ORDER BY b.created_at LIMIT 10`,
      );
      for (const p of policies) {
        const [capacity] = await db.execute(
          sql`SELECT count(*)::int AS n FROM recording r WHERE kind='buffer' AND (state IN ('queued','recording','finalizing') OR EXISTS(SELECT 1 FROM dvr_window w WHERE w.recording_id=r.id AND w.state<>'disabled' AND (w.expires_at IS NULL OR w.expires_at>now())))`,
        );
        if (Number(capacity?.n) >= config.maxBuffers) break;
        const stream = await getStream(db, String(p.stream_id));
        const [environmentCapacity] = await db.execute(
          sql`SELECT count(*)::int AS n FROM recording r WHERE kind='buffer' AND environment_id=${stream.environmentId} AND (state IN ('queued','recording','finalizing') OR EXISTS(SELECT 1 FROM dvr_window w WHERE w.recording_id=r.id AND w.state<>'disabled' AND (w.expires_at IS NULL OR w.expires_at>now())))`,
        );
        if (Number(environmentCapacity?.n) >= config.maxBuffersPerEnvironment) continue;
        const policy = recordingPolicySchema.parse({
          consentAcknowledged: true,
          allowPartial: true,
          exportMp4: false,
          maxDurationSeconds: 86400,
          retentionSeconds: 3600,
          region: config.s3Region,
        });
        await db.execute(
          sql`INSERT INTO recording(id,kind,stream_id,broadcast_id,asset_id,organization_id,project_id,environment_id,policy) VALUES(${id("recording")},'buffer',${stream.id},${String(p.broadcast_id)},${id("asset")},${stream.organizationId},${stream.projectId},${stream.environmentId},${JSON.stringify(policy)}::jsonb)`,
        );
      }
      await syncDvrWindows(db, config);
      const pending = await db.execute(
        sql`SELECT c.* FROM clip_request c JOIN recording r ON r.id=c.recording_id WHERE c.prepared=false AND r.state='queued' ORDER BY c.created_at LIMIT 1`,
      );
      for (const value of pending) {
        const c = clipRowSchema.parse(value);
        const r = await getRecording(db, c.recording_id);
        const source = await getRecording(db, c.source_recording_id);
        if (
          Date.now() - r.created_at.getTime() > 600000 ||
          ["deleted", "deleting", "failed"].includes(source.state)
        ) {
          const current = await getRecording(db, r.id, false, true);
          if (current.state === "queued")
            await setRecordingState(db, current, "failed", "CLIP_SOURCE_LOST");
          continue;
        }
        const segments = await db.execute(
          sql`SELECT s.* FROM clip_segment_pin p JOIN recording_segment s ON s.recording_id=p.recording_id AND s.position=p.position WHERE p.clip_id=${c.id} ORDER BY s.position`,
        );
        const names = [
          ...new Set(
            segments.flatMap((s) =>
              [s.name, s.init_name, s.audio_name, s.audio_init_name].filter(
                (n): n is string => typeof n === "string",
              ),
            ),
          ),
        ];
        // Reservations commit before PUT, so retries/deletion can always discover uploaded keys.
        // A preparation lease delays deletion past any bounded in-flight storage request.
        const preparing = await database.execute(
          sql`UPDATE recording SET lease_token=${id("prepare")},leased_until=now()+interval '10 minutes' WHERE id=${r.id} AND state='queued' RETURNING id`,
        );
        if (!preparing.length) continue;
        const fail = async (reason: string) => {
          const current = await getRecording(db, r.id, false, true);
          if (current.state === "queued") await setRecordingState(db, current, "failed", reason);
        };
        let copied = 0;
        for (const name of names) {
          const [existing] = await db.execute(
            sql`SELECT committed_at FROM recording_object WHERE recording_id=${r.id} AND name=${name}`,
          );
          if (existing?.committed_at) continue;
          if (copied++ >= 4) break;
          const [object] = await db.execute(
            sql`SELECT * FROM recording_object WHERE recording_id=${source.id} AND name=${name} AND committed_at IS NOT NULL`,
          );
          if (!object) {
            await fail("CLIP_SEGMENT_MISSING");
            break;
          }
          const key = `streaming/recordings/${r.project_id}/${r.environment_id}/${r.id}/${name}`;
          const [size] = await db.execute(
            sql`SELECT coalesce(sum(size_bytes),0)::bigint AS n FROM recording_object WHERE recording_id=${r.id} AND name<>${name}`,
          );
          if (
            Number(size?.n) + Number(object.size_bytes) >
            config.maxRecordingBytes / 2 - 1048576
          ) {
            await fail("CLIP_STORAGE_LIMIT");
            break;
          }
          await database.execute(
            sql`INSERT INTO recording_object(recording_id,name,object_key,sha256,size_bytes,fence) VALUES(${r.id},${name},${key},${String(object.sha256)},${Number(object.size_bytes)},0) ON CONFLICT DO NOTHING`,
          );
          await store.put(key, await store.get(String(object.object_key)));
          await db.execute(
            sql`UPDATE recording_object SET committed_at=clock_timestamp() WHERE recording_id=${r.id} AND name=${name}`,
          );
          await db.execute(
            sql`UPDATE recording SET storage_byte_seconds=storage_byte_seconds+stored_bytes*greatest(0,EXTRACT(EPOCH FROM clock_timestamp()-storage_metered_at)),storage_metered_at=clock_timestamp(),stored_bytes=stored_bytes+${Number(object.size_bytes)} WHERE id=${r.id}`,
          );
        }
        const [ready] = await db.execute(
          sql`SELECT count(*)::int AS n FROM recording_object WHERE recording_id=${r.id} AND committed_at IS NOT NULL`,
        );
        if (Number(ready?.n) !== names.length) continue;
        const current = await getRecording(db, r.id, false, true);
        if (current.state !== "queued") continue;
        for (const [index, s] of segments.entries())
          await db.execute(
            sql`INSERT INTO recording_segment(recording_id,position,session_id,generation,sequence,name,init_name,audio_name,audio_init_name,audio_duration_seconds,duration_seconds,program_date_time,discontinuity,media_start_seconds) VALUES(${r.id},${index},${String(s.session_id)},${Number(s.generation)},${Number(s.sequence)},${String(s.name)},${String(s.init_name)},${z.string().nullable().parse(s.audio_name)},${z.string().nullable().parse(s.audio_init_name)},${s.audio_duration_seconds === null ? null : Number(s.audio_duration_seconds)},${Number(s.duration_seconds)},${s.program_date_time ? z.coerce.date().parse(s.program_date_time) : null},false,${Number(s.media_start_seconds) - c.resolved_start_seconds}) ON CONFLICT DO NOTHING`,
          );
        await db.execute(sql`UPDATE clip_request SET prepared=true WHERE id=${c.id}`);
        await db.execute(
          sql`UPDATE recording SET segment_count=${segments.length},lease_token=NULL,leased_until=NULL WHERE id=${r.id}`,
        );
        await setRecordingState(db, r, "finalizing");
      }
      // Failed clip inputs are no longer needed; retain the job/usage history, not its media.
      await db.execute(
        sql`DELETE FROM recording_segment s USING recording r WHERE r.id=s.recording_id AND r.kind='clip' AND r.state='failed'`,
      );
      // Pins survive retries and are released on all terminal paths.
      await db.execute(
        sql`DELETE FROM clip_segment_pin p USING clip_request c,recording r WHERE p.clip_id=c.id AND r.id=c.recording_id AND r.state IN ('ready','failed','deleted','deleting')`,
      );
      await db.execute(
        sql`UPDATE clip_request c SET pins_released=true FROM recording r WHERE r.id=c.recording_id AND r.state IN ('ready','failed','deleted','deleting')`,
      );
    });
  };
  const evict = async () => {
    await database.transaction(async (db) => {
      const buffers = await db.execute(
        sql`SELECT r.* FROM recording r WHERE r.kind='buffer' AND r.state IN ('queued','recording','finalizing','ready','failed') ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 20`,
      );
      for (const value of buffers) {
        const r = recordingRowSchema.parse(value),
          policy = await effectiveBufferPolicy(db, r.stream_id, r.id);
        if (
          r.state === "failed" ||
          !policy.enabled ||
          (r.state === "ready" &&
            !(
              await db.execute(
                sql`SELECT id FROM dvr_window WHERE recording_id=${r.id} AND state<>'disabled' AND (expires_at IS NULL OR expires_at>now())`,
              )
            ).length)
        ) {
          const [pinned] = await db.execute(
            sql`SELECT (SELECT count(*) FROM clip_segment_pin WHERE recording_id=${r.id})+(SELECT count(*) FROM dvr_segment_pin WHERE recording_id=${r.id}) AS n`,
          );
          if (Number(pinned?.n)) {
            if (!policy.enabled)
              await db.execute(sql`UPDATE recording SET stop_requested=true WHERE id=${r.id}`);
          } else await deleteRecording(db, r);
          continue;
        }
        const obsolete = await db.execute(
          sql`SELECT position FROM recording_segment s WHERE recording_id=${r.id} AND (media_start_seconds+duration_seconds<${r.duration_seconds - policy.durationSeconds} OR (${r.stored_bytes}>${policy.maxBytes * 0.7} AND position<${r.segment_count - 4})) AND NOT EXISTS(SELECT 1 FROM clip_segment_pin p WHERE p.recording_id=s.recording_id AND p.position=s.position) AND NOT EXISTS(SELECT 1 FROM dvr_segment_pin d WHERE d.recording_id=s.recording_id AND d.position=s.position) AND s.committed_at<now()-interval '60 seconds' ORDER BY position LIMIT 100`,
        );
        for (const s of obsolete)
          await db.execute(
            sql`DELETE FROM recording_segment WHERE recording_id=${r.id} AND position=${Number(s.position)}`,
          );
        const unused = await db.execute(
          sql`SELECT o.* FROM recording_object o WHERE o.recording_id=${r.id} AND o.committed_at<now()-interval '30 seconds' AND NOT EXISTS(SELECT 1 FROM recording_segment s WHERE s.recording_id=o.recording_id AND (s.name=o.name OR s.init_name=o.name OR s.audio_name=o.name OR s.audio_init_name=o.name)) LIMIT 100`,
        );
        for (const o of unused) {
          await store.remove(String(o.object_key));
          await db.execute(
            sql`DELETE FROM recording_object WHERE recording_id=${r.id} AND name=${String(o.name)}`,
          );
          await db.execute(
            sql`UPDATE recording SET storage_byte_seconds=storage_byte_seconds+stored_bytes*greatest(0,EXTRACT(EPOCH FROM now()-storage_metered_at)),storage_metered_at=now(),stored_bytes=greatest(0,stored_bytes-${Number(o.size_bytes)}) WHERE id=${r.id}`,
          );
        }
      }
    });
  };
  const timer = setInterval(() => {
    running ??= tick()
      .catch((err: unknown) => {
        app.log.error({ err }, "Clip maintenance failed");
      })
      .finally(() => {
        running = undefined;
      });
  }, 3000);
  const evictionTimer = setInterval(() => {
    evicting ??= evict()
      .catch((err: unknown) => {
        app.log.error({ err }, "Buffer eviction failed");
      })
      .finally(() => {
        evicting = undefined;
      });
  }, 3000);
  evictionTimer.unref();
  timer.unref();
  return async () => {
    clearInterval(timer);
    clearInterval(evictionTimer);
    await Promise.all([running, evicting]);
  };
}
