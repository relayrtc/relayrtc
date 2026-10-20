import { clipEvent } from "./clip-service.js";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { RecordingPolicy, RecordingResource, MediaAsset } from "@relayrtc/types";
import { recordingPolicySchema } from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { id, conflict, missing, type Transaction, type StreamRow } from "./repository.js";
import type { StreamingConfig } from "./config.js";
import { StreamingStore } from "./store.js";
import { createMaintenanceRunner } from "./maintenance.js";

const date = z.coerce.date();
export const recordingRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["recording", "buffer", "clip"]),
  stream_id: z.string(),
  broadcast_id: z.string(),
  asset_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  state: z.enum(["queued", "recording", "finalizing", "ready", "failed", "deleting", "deleted"]),
  policy: recordingPolicySchema,
  partial: z.boolean(),
  last_error: z.string().nullable(),
  stop_requested: z.boolean(),
  fence: z.number(),
  lease_token: z.string().nullable(),
  leased_until: date.nullable(),
  heartbeat_at: date.nullable(),
  attempts: z.number(),
  next_attempt_at: date.optional(),
  source_session_id: z.string().nullable(),
  source_generation: z.number().nullable(),
  source_sequence: z.coerce.number().nullable(),
  duration_seconds: z.coerce.number(),
  processing_seconds: z.coerce.number(),
  stored_bytes: z.coerce.number(),
  storage_byte_seconds: z.coerce.number(),
  segment_count: z.number(),
  grant_epoch: z.number(),
  codecs: z.array(z.string()),
  export_fence: z.number().nullable(),
  mp4_parts: z.number(),
  has_thumbnail: z.boolean(),
  created_at: date,
  started_at: date.nullable(),
  ended_at: date.nullable(),
  expires_at: date.nullable(),
});
export type RecordingRow = z.infer<typeof recordingRowSchema>;
export async function getRecording(db: Transaction, key: string, asset = false, lock = false) {
  const rows = await db.execute(
    sql`SELECT * FROM recording WHERE ${asset ? sql`asset_id` : sql`id`}=${key} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  if (!rows[0]) throw missing();
  return recordingRowSchema.parse(rows[0]);
}
export function publicRecording(r: RecordingRow): RecordingResource {
  return {
    id: r.id,
    streamId: r.stream_id,
    broadcastId: r.broadcast_id,
    assetId: r.asset_id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    state: r.state,
    policy: r.policy,
    partial: r.partial,
    lastError: r.last_error,
    durationSeconds: r.duration_seconds,
    storedBytes: r.stored_bytes,
    storageByteSeconds: r.storage_byte_seconds,
    processingSeconds: r.processing_seconds,
    segmentCount: r.segment_count,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null,
    expiresAt: r.expires_at?.toISOString() ?? null,
  };
}
export function publicAsset(r: RecordingRow): MediaAsset {
  return {
    id: r.asset_id,
    recordingId: r.id,
    streamId: r.stream_id,
    broadcastId: r.broadcast_id,
    state: r.state,
    partial: r.partial,
    durationSeconds: r.duration_seconds,
    region: r.policy.region,
    formats: r.state === "ready" ? (r.mp4_parts > 0 ? ["hls", "mp4"] : ["hls"]) : [],
    hasThumbnail: r.has_thumbnail,
    codecs: r.codecs,
    sizeBytes: r.stored_bytes,
    expiresAt: r.expires_at?.toISOString() ?? null,
  };
}
export async function recordingEvent(
  db: Transaction,
  r: RecordingRow,
  type: string,
  details: Record<string, unknown> = {},
) {
  const eventId = id("event"),
    occurredAt = new Date().toISOString();
  const [eventSequence] = await db.execute(
    sql`UPDATE recording SET event_sequence=event_sequence+1 WHERE id=${r.id} RETURNING event_sequence`,
  );
  const body = JSON.stringify({
    id: eventId,
    type,
    projectId: r.project_id,
    environmentId: r.environment_id,
    occurredAt,
    data: {
      streamId: r.stream_id,
      broadcastId: r.broadcast_id,
      recordingId: r.id,
      assetId: r.asset_id,
      state: r.state,
      partial: r.partial,
      actor: { type: "SYSTEM", id: "recording-runtime", name: "Recording runtime" },
      sequence: Number(eventSequence?.event_sequence),
      ...details,
    },
  });
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${r.project_id},${r.environment_id},${type},${occurredAt},${body}::jsonb,${body})`,
  );
}
export async function setRecordingState(
  db: Transaction,
  r: RecordingRow,
  state: RecordingRow["state"],
  reason: string | null = null,
) {
  if (r.state === state) return r;
  const [row] = await db.execute(
    sql`UPDATE recording SET state=${state},last_error=${reason},cleanup_after=CASE WHEN ${state} IN ('ready','failed') THEN now()+interval '2 minutes' ELSE cleanup_after END,expires_at=CASE WHEN ${state}='failed' THEN coalesce(expires_at,now()+make_interval(secs=>${r.policy.retentionSeconds})) ELSE expires_at END WHERE id=${r.id} RETURNING *`,
  );
  const next = recordingRowSchema.parse(row);
  const event = state === "recording" ? "started" : state;
  if (r.kind === "clip" && ["finalizing", "ready", "failed", "deleted"].includes(state))
    await clipEvent(db, r.id, `clip.${state === "finalizing" ? "rendering" : state}`);
  if (
    r.kind === "recording" &&
    ["started", "finalizing", "ready", "failed", "deleted"].includes(event)
  )
    await recordingEvent(db, next, `recording.${event}`);
  return next;
}
export async function admitRecording(
  db: Transaction,
  stream: StreamRow,
  broadcastId: string | undefined,
  policy: RecordingPolicy,
  config: StreamingConfig,
) {
  if (policy.region !== config.s3Region)
    throw conflict("RECORDING_REGION_UNAVAILABLE", "Select the configured storage region.");
  if (!policy.consentAcknowledged)
    throw conflict("RECORDING_CONSENT_REQUIRED", "Acknowledge recording consent before capture.");
  await db.execute(sql`SELECT pg_advisory_xact_lock(810035)`);
  const runs = await db.execute(
    sql`SELECT id FROM broadcast_run WHERE stream_id=${stream.id} AND desired_state='running' AND state NOT IN ('stopping','stopped','failed') ${broadcastId ? sql`AND id=${broadcastId}` : sql``} FOR SHARE`,
  );
  if (runs.length !== 1)
    throw conflict(
      "RECORDING_BROADCAST_REQUIRED",
      "Select exactly one running broadcast belonging to this stream.",
    );
  const runId = String(runs[0]?.id);
  const [duplicate] = await db.execute(
    sql`SELECT id FROM recording WHERE broadcast_id=${runId} AND kind='recording' AND state IN ('queued','recording','finalizing')`,
  );
  if (duplicate)
    throw conflict("RECORDING_ALREADY_ACTIVE", "This broadcast already has an active recording.");
  const [count] = await db.execute(
    sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE environment_id=${stream.environmentId})::int AS environment FROM recording WHERE kind='recording' AND (state IN ('queued','recording','finalizing') OR leased_until>now())`,
  );
  if (
    Number(count?.total) >= config.maxRecordings ||
    Number(count?.environment) >= config.maxRecordingsPerEnvironment
  )
    throw conflict("RECORDING_CAPACITY", "Recording capacity is full.");
  const [row] = await db.execute(
    sql`INSERT INTO recording(id,stream_id,broadcast_id,asset_id,organization_id,project_id,environment_id,policy) VALUES(${id("recording")},${stream.id},${runId},${id("asset")},${stream.organizationId},${stream.projectId},${stream.environmentId},${JSON.stringify(policy)}::jsonb) RETURNING *`,
  );
  return recordingRowSchema.parse(row);
}
export async function deleteRecording(db: Transaction, r: RecordingRow) {
  if (r.state === "deleted" || r.state === "deleting") return r;
  await db.execute(
    sql`UPDATE recording SET deletion_requested_at=now(),stop_requested=true,grant_epoch=grant_epoch+1 WHERE id=${r.id}`,
  );
  await db.execute(
    sql`UPDATE recording_access_grant SET revoked_at=now() WHERE recording_id=${r.id} AND revoked_at IS NULL`,
  );
  return setRecordingState(db, r, "deleting");
}
export function registerRecordingMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  let running: Promise<void> | undefined;
  const store = new StreamingStore(config);
  const run = createMaintenanceRunner(app);
  const tick = async () => {
    // One controller performs state transitions and byte-time accounting at a time.
    await database.transaction(async (db) => {
      const [lock] = await db.execute(sql`SELECT pg_try_advisory_xact_lock(810036) AS acquired`);
      if (!lock?.acquired) return;
      // Meter using a separate per-recording timestamp, while retaining historical totals after deletion.
      await db.execute(
        sql`UPDATE recording r SET storage_byte_seconds=r.storage_byte_seconds+r.stored_bytes*greatest(0,EXTRACT(EPOCH FROM now()-r.storage_metered_at)),storage_metered_at=now() WHERE stored_bytes>0 AND storage_metered_at<now()-interval '1 minute'`,
      );
      const rows = await db.execute(
        sql`SELECT r.* FROM recording r WHERE (state IN ('queued','recording','finalizing') AND NOT (kind='clip' AND state='queued')) OR (expires_at<=now() AND state NOT IN ('deleted','deleting')) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100`,
      );
      for (const value of rows) {
        let r = recordingRowSchema.parse(value);
        if (r.expires_at && r.expires_at.getTime() <= Date.now()) {
          await deleteRecording(db, r);
          continue;
        }
        const [run] = await db.execute(
          sql`SELECT desired_state,state FROM broadcast_run WHERE id=${r.broadcast_id}`,
        );
        if (
          (r.kind !== "clip" && run?.desired_state !== "running") ||
          (r.kind !== "clip" && ["stopping", "stopped", "failed"].includes(String(run?.state))) ||
          (r.started_at &&
            Date.now() - r.started_at.getTime() >= r.policy.maxDurationSeconds * 1000)
        ) {
          await db.execute(sql`UPDATE recording SET stop_requested=true WHERE id=${r.id}`);
          r = { ...r, stop_requested: true };
        }
        if (r.leased_until && r.leased_until.getTime() > Date.now()) continue;
        if (r.lease_token) {
          await db.execute(
            sql`UPDATE recording SET lease_token=NULL,leased_until=NULL,worker_id=NULL,last_error='WORKER_INTERRUPTED',next_attempt_at=now()+make_interval(secs=>${Math.min(60, 5 * 2 ** Math.max(0, r.attempts - 1))}) WHERE id=${r.id}`,
          );
          r = { ...r, last_error: "WORKER_INTERRUPTED" };
        }
        if (r.attempts >= 5) {
          if (r.kind === "buffer" && r.segment_count > 0) {
            await setRecordingState(db, r, "ready", r.last_error);
          } else if (r.state !== "finalizing" && r.segment_count > 0 && r.policy.allowPartial) {
            await db.execute(
              sql`UPDATE recording SET partial=true,stop_requested=true,attempts=0,ended_at=now() WHERE id=${r.id}`,
            );
            await setRecordingState(db, { ...r, partial: true }, "finalizing");
          } else await setRecordingState(db, r, "failed", "RECORDING_RETRIES_EXHAUSTED");
          continue;
        }
        if (r.stop_requested && r.state !== "finalizing") {
          if (r.last_error && r.kind !== "buffer") {
            await db.execute(sql`UPDATE recording SET partial=true WHERE id=${r.id}`);
            r = { ...r, partial: true };
          }
          if (!r.segment_count) await setRecordingState(db, r, "failed", "RECORDING_NO_MEDIA");
          else if (r.partial && !r.policy.allowPartial)
            await setRecordingState(db, r, "failed", "RECORDING_PARTIAL_NOT_ALLOWED");
          else if (r.kind === "buffer") {
            // A rolling window is not a full recording: keep its cumulative timeline for
            // pinned clip inputs, then let buffer cleanup retire it without a VOD export.
            await setRecordingState(db, r, "ready", r.last_error);
          } else {
            await db.execute(sql`UPDATE recording SET attempts=0,ended_at=now() WHERE id=${r.id}`);
            await setRecordingState(db, r, "finalizing");
          }
        }
      }
      await db.execute(
        sql`DELETE FROM recording_access_grant WHERE expires_at<now()-interval '1 day'`,
      );
    });
    // Only delete objects after any previous worker lease and in-flight bounded PUT have elapsed.
    const doomed = await database.execute(
      sql`SELECT id FROM recording WHERE state='deleting' AND deletion_requested_at<now()-interval '30 seconds' AND (leased_until IS NULL OR leased_until<now()-interval '30 seconds') AND NOT EXISTS(SELECT 1 FROM clip_segment_pin p WHERE p.recording_id=recording.id) AND NOT EXISTS(SELECT 1 FROM dvr_segment_pin p WHERE p.recording_id=recording.id) LIMIT 10`,
    );
    for (const item of doomed)
      await run(`recording:delete:${String(item.id)}`, async () => {
        const objects = await database.execute(
          sql`SELECT name,object_key FROM recording_object WHERE recording_id=${String(item.id)} LIMIT 100`,
        );
        for (const object of objects) {
          await store.remove(String(object.object_key));
          await database.execute(
            sql`DELETE FROM recording_segment WHERE recording_id=${String(item.id)} AND (name=${String(object.name)} OR init_name=${String(object.name)} OR audio_name=${String(object.name)} OR audio_init_name=${String(object.name)})`,
          );
          await database.execute(
            sql`WITH gone AS (DELETE FROM recording_object WHERE recording_id=${String(item.id)} AND name=${String(object.name)} RETURNING size_bytes,committed_at) UPDATE recording SET storage_byte_seconds=storage_byte_seconds+stored_bytes*greatest(0,EXTRACT(EPOCH FROM clock_timestamp()-storage_metered_at)),storage_metered_at=clock_timestamp(),stored_bytes=greatest(0,stored_bytes-coalesce((SELECT sum(size_bytes) FROM gone WHERE committed_at IS NOT NULL),0)) WHERE id=${String(item.id)}`,
          );
        }
        await database.transaction(async (db) => {
          const r = await getRecording(db, String(item.id), false, true);
          const [remaining] = await db.execute(
            sql`SELECT count(*)::int AS n FROM recording_object WHERE recording_id=${r.id}`,
          );
          if (!Number(remaining?.n)) {
            await db.execute(
              sql`UPDATE recording SET stored_bytes=0,lease_token=NULL,leased_until=NULL,worker_id=NULL WHERE id=${r.id}`,
            );
            await setRecordingState(db, r, "deleted");
          }
        });
      });
    // Pending uploads and obsolete finalize attempts have durable names even after a crash.
    const unusedObject = sql`(o.committed_at IS NULL OR (r.kind='clip' AND r.state='failed' AND NOT EXISTS(SELECT 1 FROM recording_segment s WHERE s.recording_id=o.recording_id)) OR (r.state='ready' AND (((o.name LIKE 'export_%' OR o.name LIKE 'vod_%') AND o.fence<>r.export_fence) OR ((o.name LIKE 'init_%' OR o.name LIKE 'seg_%') AND NOT EXISTS(SELECT 1 FROM recording_segment s WHERE s.recording_id=o.recording_id AND (s.name=o.name OR s.init_name=o.name OR s.audio_name=o.name OR s.audio_init_name=o.name))))))`;
    const orphans = await database.execute(
      sql`SELECT o.recording_id,o.name,o.object_key,o.size_bytes,o.committed_at FROM recording_object o JOIN recording r ON r.id=o.recording_id WHERE (r.cleanup_after<=now() AND r.cleanup_completed=false AND r.state IN ('ready','failed') AND ${unusedObject}) OR (r.state='finalizing' AND o.fence<r.fence AND (o.name LIKE 'export_%' OR o.name LIKE 'vod_%') AND (o.committed_at IS NOT NULL OR r.next_attempt_at<now()-interval '30 seconds')) ORDER BY o.created_at LIMIT 100`,
    );
    for (const o of orphans)
      await run(`recording:orphan:${String(o.recording_id)}:${String(o.name)}`, async () => {
        await store.remove(String(o.object_key));
        await database.transaction(async (db) => {
          const deleted = await db.execute(
            sql`DELETE FROM recording_object WHERE recording_id=${String(o.recording_id)} AND name=${String(o.name)} RETURNING size_bytes,committed_at`,
          );
          if (deleted[0]?.committed_at)
            await db.execute(
              sql`UPDATE recording SET storage_byte_seconds=storage_byte_seconds+stored_bytes*greatest(0,EXTRACT(EPOCH FROM clock_timestamp()-storage_metered_at)),storage_metered_at=clock_timestamp(),stored_bytes=greatest(0,stored_bytes-${Number(deleted[0].size_bytes)}) WHERE id=${String(o.recording_id)}`,
            );
        });
      });
    await database.execute(
      sql`UPDATE recording r SET cleanup_completed=true WHERE r.cleanup_after<=now() AND r.cleanup_completed=false AND r.state IN ('ready','failed') AND NOT EXISTS(SELECT 1 FROM recording_object o WHERE o.recording_id=r.id AND ${unusedObject})`,
    );
  };
  const timer = setInterval(() => {
    running ??= tick()
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Recording maintenance failed");
      })
      .finally(() => {
        running = undefined;
      });
  }, 3000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
