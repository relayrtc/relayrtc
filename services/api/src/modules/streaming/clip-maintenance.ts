import type { RelayKitDatabase } from "@relayrtc/database";
import { streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import { recordingPolicySchema } from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clipRowSchema } from "./clip-service.js";
import {
  clipPreparationLeaseSeconds,
  clipPreparationMaxAttempts,
  clipPreparationTimeoutMs,
  clipRenderingTimeoutMs,
} from "./clip-progress.js";
import type { StreamingConfig } from "./config.js";
import { effectiveBufferPolicy, syncDvrWindows } from "./dvr-service.js";
import {
  boundedMaintenanceTransaction,
  createMaintenanceRunner,
  maintenanceBatch,
  maintenanceTransaction,
} from "./maintenance.js";
import {
  deleteRecording,
  getRecording,
  recordingRowSchema,
  setRecordingState,
  type RecordingRow,
} from "./recording-service.js";
import { getStream, id, type Transaction } from "./repository.js";
import { StreamingStore } from "./store.js";

class ClipPreparationError extends Error {}

async function releaseClipInputs(db: Transaction, recordingId: string) {
  await db.execute(sql`DELETE FROM recording_segment WHERE recording_id=${recordingId}`);
  await db.execute(
    sql`DELETE FROM clip_segment_pin p USING clip_request c WHERE p.clip_id=c.id AND c.recording_id=${recordingId}`,
  );
  await db.execute(
    sql`UPDATE clip_request SET pins_released=true WHERE recording_id=${recordingId}`,
  );
}

async function failClip(
  db: Transaction,
  recording: RecordingRow,
  code: string,
  attempts = recording.attempts,
) {
  const [row] = await db.execute(
    sql`UPDATE recording SET attempts=${attempts},fence=fence+1,lease_token=NULL,worker_id=NULL,leased_until=greatest(coalesce(leased_until,now()),now()+interval '30 seconds'),stop_requested=true,ended_at=coalesce(ended_at,now()) WHERE id=${recording.id} RETURNING *`,
  );
  await setRecordingState(db, recordingRowSchema.parse(row), "failed", code);
  await releaseClipInputs(db, recording.id);
}

async function expireClip(database: RelayKitDatabase, recordingId: string) {
  await maintenanceTransaction(database, `clip:${recordingId}`, async (db) => {
    const [row] = await db.execute(
      sql`SELECT * FROM recording WHERE id=${recordingId} AND kind='clip' AND state IN ('queued','finalizing') FOR UPDATE SKIP LOCKED`,
    );
    if (!row) return;
    const r = recordingRowSchema.parse(row);
    const timeout = r.state === "queued" ? clipPreparationTimeoutMs : clipRenderingTimeoutMs;
    const started = r.state === "queued" ? r.created_at : (r.ended_at ?? r.created_at);
    if (Date.now() - started.getTime() >= timeout)
      await failClip(
        db,
        r,
        r.state === "queued" ? "CLIP_PREPARATION_TIMEOUT" : "CLIP_RENDERING_TIMEOUT",
      );
    else if (
      r.attempts >= clipPreparationMaxAttempts &&
      (!r.leased_until || r.leased_until.getTime() <= Date.now())
    )
      await failClip(
        db,
        r,
        r.state === "queued"
          ? "CLIP_PREPARATION_RETRIES_EXHAUSTED"
          : "CLIP_RENDERING_RETRIES_EXHAUSTED",
      );
  });
}

async function admitBuffer(
  database: RelayKitDatabase,
  broadcastId: string,
  config: StreamingConfig,
) {
  await maintenanceTransaction(database, "buffer:capacity", async (db) => {
    const [run] = await db.execute(
      sql`SELECT b.id,b.stream_id FROM broadcast_run b JOIN streaming_stream s ON s.id=b.stream_id LEFT JOIN stream_buffer_policy p ON p.stream_id=s.id LEFT JOIN stream_dvr_policy d ON d.stream_id=s.id WHERE b.id=${broadcastId} AND (p.policy->>'enabled'='true' OR (${config.dvrEnabled} AND d.policy->>'enabled'='true')) AND s.status='active' AND b.desired_state='running' AND b.state IN ('live','reconnecting') AND NOT EXISTS(SELECT 1 FROM recording r WHERE r.broadcast_id=b.id AND r.kind='buffer') FOR SHARE OF b,s`,
    );
    if (!run) return;
    const stream = await getStream(db, String(run.stream_id));
    const [capacity] = await db.execute(
      sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE environment_id=${stream.environmentId})::int AS environment FROM recording r WHERE kind='buffer' AND (state IN ('queued','recording','finalizing') OR EXISTS(SELECT 1 FROM dvr_window w WHERE w.recording_id=r.id AND w.state<>'disabled' AND (w.expires_at IS NULL OR w.expires_at>now())))`,
    );
    if (
      Number(capacity?.total) >= config.maxBuffers ||
      Number(capacity?.environment) >= config.maxBuffersPerEnvironment
    )
      return;
    const policy = recordingPolicySchema.parse({
      consentAcknowledged: true,
      allowPartial: true,
      exportMp4: false,
      maxDurationSeconds: 86400,
      retentionSeconds: 3600,
      region: config.s3Region,
    });
    await db.execute(
      sql`INSERT INTO recording(id,kind,stream_id,broadcast_id,asset_id,organization_id,project_id,environment_id,policy) VALUES(${id("recording")},'buffer',${stream.id},${String(run.id)},${id("asset")},${stream.organizationId},${stream.projectId},${stream.environmentId},${JSON.stringify(policy)}::jsonb) ON CONFLICT DO NOTHING`,
    );
  });
}

async function claimClip(database: RelayKitDatabase, clipId: string) {
  return maintenanceTransaction(database, `clip:claim:${clipId}`, async (db) => {
    const [value] = await db.execute(
      sql`SELECT r.* FROM recording r JOIN clip_request c ON c.recording_id=r.id WHERE c.id=${clipId} AND c.prepared=false AND r.state='queued' AND r.next_attempt_at<=now() AND (r.leased_until IS NULL OR r.leased_until<=now()) FOR UPDATE OF r SKIP LOCKED`,
    );
    if (!value) return;
    const r = recordingRowSchema.parse(value);
    if (Date.now() - r.created_at.getTime() >= clipPreparationTimeoutMs) {
      await failClip(db, r, "CLIP_PREPARATION_TIMEOUT");
      return;
    }
    const attempts = r.attempts + (r.lease_token ? 1 : 0);
    if (attempts >= clipPreparationMaxAttempts) {
      await failClip(db, r, "CLIP_PREPARATION_RETRIES_EXHAUSTED", attempts);
      return;
    }
    const [clip] = await db.execute(sql`SELECT * FROM clip_request WHERE id=${clipId}`);
    const c = clipRowSchema.parse(clip);
    const [updated] = await db.execute(
      sql`UPDATE recording SET fence=fence+1,lease_token=${id("prepare")},worker_id='clip-preparation',leased_until=now()+make_interval(secs=>${clipPreparationLeaseSeconds}),heartbeat_at=now(),attempts=${attempts},last_error=CASE WHEN lease_token IS NOT NULL THEN 'CLIP_PREPARATION_INTERRUPTED' ELSE last_error END WHERE id=${r.id} RETURNING *`,
    );
    return { clip: c, recording: recordingRowSchema.parse(updated) };
  });
}

async function currentClaim(db: Transaction, claim: RecordingRow) {
  const r = await getRecording(db, claim.id, false, true);
  if (
    r.state !== "queued" ||
    r.fence !== claim.fence ||
    r.lease_token !== claim.lease_token ||
    !r.leased_until ||
    r.leased_until.getTime() <= Date.now()
  )
    throw new ClipPreparationError("CLIP_PREPARATION_LEASE_EXPIRED");
  if (Date.now() - r.created_at.getTime() >= clipPreparationTimeoutMs)
    throw new ClipPreparationError("CLIP_PREPARATION_TIMEOUT");
  return r;
}

async function prepareClip(
  database: RelayKitDatabase,
  clipId: string,
  config: StreamingConfig,
  store: StreamingStore,
) {
  const claim = await claimClip(database, clipId);
  if (!claim) return;
  const { clip, recording } = claim;
  try {
    const source = await boundedMaintenanceTransaction(database, (db) =>
      getRecording(db, clip.source_recording_id),
    );
    if (
      ["deleted", "deleting", "failed"].includes(source.state) ||
      (source.expires_at && source.expires_at.getTime() <= Date.now())
    )
      throw new ClipPreparationError("CLIP_SOURCE_LOST");
    const segments = await database.execute(
      sql`SELECT s.* FROM clip_segment_pin p JOIN recording_segment s ON s.recording_id=p.recording_id AND s.position=p.position WHERE p.clip_id=${clip.id} ORDER BY s.position`,
    );
    if (!segments.length) throw new ClipPreparationError("CLIP_SEGMENT_MISSING");
    const names = [
      ...new Set(
        segments.flatMap((s) =>
          [s.name, s.init_name, s.audio_name, s.audio_init_name].filter(
            (n): n is string => typeof n === "string",
          ),
        ),
      ),
    ];
    let copied = 0;
    for (const name of names) {
      const object = await boundedMaintenanceTransaction(database, async (db) => {
        await currentClaim(db, recording);
        await db.execute(
          sql`UPDATE recording SET heartbeat_at=now(),leased_until=now()+make_interval(secs=>${clipPreparationLeaseSeconds}) WHERE id=${recording.id}`,
        );
        const [sourceObject] = await db.execute(
          sql`SELECT * FROM recording_object WHERE recording_id=${source.id} AND name=${name} AND committed_at IS NOT NULL`,
        );
        if (!sourceObject) throw new ClipPreparationError("CLIP_SEGMENT_MISSING");
        const [existing] = await db.execute(
          sql`SELECT * FROM recording_object WHERE recording_id=${recording.id} AND name=${name}`,
        );
        if (
          existing &&
          (existing.sha256 !== sourceObject.sha256 ||
            Number(existing.size_bytes) !== Number(sourceObject.size_bytes))
        )
          throw new ClipPreparationError("CLIP_SEGMENT_CONFLICT");
        if (existing?.committed_at) return null;
        if (copied >= 4) return undefined;
        const [size] = await db.execute(
          sql`SELECT coalesce(sum(size_bytes),0)::bigint AS n FROM recording_object WHERE recording_id=${recording.id} AND name<>${name}`,
        );
        if (
          Number(size?.n) + Number(sourceObject.size_bytes) >
          config.maxRecordingBytes / 2 - 1048576
        )
          throw new ClipPreparationError("CLIP_STORAGE_LIMIT");
        const key = `streaming/recordings/${recording.project_id}/${recording.environment_id}/${recording.id}/${name}`;
        await db.execute(
          sql`INSERT INTO recording_object(recording_id,name,object_key,sha256,size_bytes,fence) VALUES(${recording.id},${name},${key},${String(sourceObject.sha256)},${Number(sourceObject.size_bytes)},${recording.fence}) ON CONFLICT DO NOTHING`,
        );
        return {
          key,
          sourceKey: String(sourceObject.object_key),
          sha256: String(sourceObject.sha256),
          size: Number(sourceObject.size_bytes),
        };
      });
      if (object === undefined) break;
      if (object === null) continue;
      const body = await store.get(object.sourceKey);
      if (body.length !== object.size || streamingSecretHash(body) !== object.sha256)
        throw new ClipPreparationError("CLIP_SEGMENT_CONFLICT");
      await store.put(object.key, body);
      await boundedMaintenanceTransaction(database, async (db) => {
        await currentClaim(db, recording);
        const committed = await db.execute(
          sql`UPDATE recording_object SET committed_at=clock_timestamp(),metered_at=clock_timestamp() WHERE recording_id=${recording.id} AND name=${name} AND committed_at IS NULL RETURNING size_bytes`,
        );
        if (committed.length)
          await db.execute(
            sql`UPDATE recording SET storage_byte_seconds=storage_byte_seconds+stored_bytes*greatest(0,EXTRACT(EPOCH FROM clock_timestamp()-storage_metered_at)),storage_metered_at=clock_timestamp(),stored_bytes=stored_bytes+${object.size} WHERE id=${recording.id}`,
          );
      });
      copied++;
    }
    await boundedMaintenanceTransaction(database, async (db) => {
      const r = await currentClaim(db, recording);
      const [ready] = await db.execute(
        sql`SELECT count(*)::int AS n FROM recording_object WHERE recording_id=${r.id} AND committed_at IS NOT NULL AND name=ANY(ARRAY[${sql.join(
          names.map((name) => sql`${name}`),
          sql`, `,
        )}]::text[])`,
      );
      if (Number(ready?.n) !== names.length) {
        await db.execute(
          sql`UPDATE recording SET lease_token=NULL,leased_until=NULL,worker_id=NULL,next_attempt_at=now(),last_error=NULL WHERE id=${r.id}`,
        );
        return;
      }
      for (const [index, s] of segments.entries())
        await db.execute(
          sql`INSERT INTO recording_segment(recording_id,position,session_id,generation,sequence,name,init_name,audio_name,audio_init_name,audio_duration_seconds,duration_seconds,program_date_time,discontinuity,media_start_seconds) VALUES(${r.id},${index},${String(s.session_id)},${Number(s.generation)},${Number(s.sequence)},${String(s.name)},${String(s.init_name)},${z.string().nullable().parse(s.audio_name)},${z.string().nullable().parse(s.audio_init_name)},${s.audio_duration_seconds === null ? null : Number(s.audio_duration_seconds)},${Number(s.duration_seconds)},${s.program_date_time ? z.coerce.date().parse(s.program_date_time).toISOString() : null},false,${Number(s.media_start_seconds) - clip.resolved_start_seconds}) ON CONFLICT DO NOTHING`,
        );
      await db.execute(sql`UPDATE clip_request SET prepared=true WHERE id=${clip.id}`);
      const [updated] = await db.execute(
        sql`UPDATE recording SET segment_count=${segments.length},attempts=0,lease_token=NULL,leased_until=NULL,worker_id=NULL,next_attempt_at=now(),ended_at=now() WHERE id=${r.id} RETURNING *`,
      );
      await setRecordingState(db, recordingRowSchema.parse(updated), "finalizing");
    });
  } catch (error) {
    await boundedMaintenanceTransaction(database, async (db) => {
      const r = await getRecording(db, recording.id, false, true);
      if (
        r.state !== "queued" ||
        r.fence !== recording.fence ||
        r.lease_token !== recording.lease_token
      )
        return;
      const code = error instanceof ClipPreparationError ? error.message : "CLIP_PREPARATION_RETRY";
      const terminal = [
        "CLIP_SOURCE_LOST",
        "CLIP_SEGMENT_MISSING",
        "CLIP_SEGMENT_CONFLICT",
        "CLIP_STORAGE_LIMIT",
        "CLIP_PREPARATION_TIMEOUT",
      ].includes(code);
      const attempts = r.attempts + 1;
      if (terminal || attempts >= clipPreparationMaxAttempts)
        await failClip(db, r, terminal ? code : "CLIP_PREPARATION_RETRIES_EXHAUSTED", attempts);
      else {
        const delay = Math.min(60, 5 * 2 ** (attempts - 1));
        await db.execute(
          sql`UPDATE recording SET attempts=${attempts},lease_token=NULL,leased_until=NULL,worker_id=NULL,last_error=${code},next_attempt_at=now()+make_interval(secs=>${delay}) WHERE id=${r.id}`,
        );
      }
    });
  }
}

async function evictBuffer(database: RelayKitDatabase, recordingId: string, store: StreamingStore) {
  await maintenanceTransaction(database, `buffer:evict:${recordingId}`, async (db) => {
    const [value] = await db.execute(
      sql`SELECT * FROM recording WHERE id=${recordingId} AND kind='buffer' AND state IN ('queued','recording','finalizing','ready','failed') FOR UPDATE SKIP LOCKED`,
    );
    if (!value) return;
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
      return;
    }
    const obsolete = await db.execute(
      sql`SELECT position FROM recording_segment s WHERE recording_id=${r.id} AND (media_start_seconds+duration_seconds<${r.duration_seconds - policy.durationSeconds} OR (${r.stored_bytes}>${policy.maxBytes * 0.7} AND position<${r.segment_count - 4})) AND NOT EXISTS(SELECT 1 FROM clip_segment_pin p WHERE p.recording_id=s.recording_id AND p.position=s.position) AND NOT EXISTS(SELECT 1 FROM dvr_segment_pin d WHERE d.recording_id=s.recording_id AND d.position=s.position) AND s.committed_at<now()-interval '60 seconds' ORDER BY position LIMIT 100`,
    );
    for (const s of obsolete)
      await db.execute(
        sql`DELETE FROM recording_segment WHERE recording_id=${r.id} AND position=${Number(s.position)}`,
      );
    const unused = await db.execute(
      sql`SELECT o.* FROM recording_object o WHERE o.recording_id=${r.id} AND o.committed_at<now()-interval '30 seconds' AND NOT EXISTS(SELECT 1 FROM recording_segment s WHERE s.recording_id=o.recording_id AND (s.name=o.name OR s.init_name=o.name OR s.audio_name=o.name OR s.audio_init_name=o.name)) ORDER BY o.created_at LIMIT 4`,
    );
    for (const object of unused) {
      await store.remove(String(object.object_key));
      const deleted = await db.execute(
        sql`DELETE FROM recording_object WHERE recording_id=${r.id} AND name=${String(object.name)} RETURNING size_bytes`,
      );
      if (deleted.length)
        await db.execute(
          sql`UPDATE recording SET storage_byte_seconds=storage_byte_seconds+stored_bytes*greatest(0,EXTRACT(EPOCH FROM now()-storage_metered_at)),storage_metered_at=now(),stored_bytes=greatest(0,stored_bytes-${Number(deleted[0]?.size_bytes)}) WHERE id=${r.id}`,
        );
    }
  });
}

export function registerClipMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  const store = new StreamingStore(config),
    run = createMaintenanceRunner(app);
  const deadlines = async () => {
    const clips = await database.execute(
      sql`SELECT id FROM recording WHERE kind='clip' AND state IN ('queued','finalizing') AND (created_at<now()-interval '10 minutes' OR attempts>=${clipPreparationMaxAttempts}) ORDER BY created_at LIMIT 100`,
    );
    await maintenanceBatch(clips, (r) =>
      run(`clip:deadline:${String(r.id)}`, () => expireClip(database, String(r.id))),
    );
  };
  const admission = async () => {
    const runs = await database.execute(
      sql`SELECT b.id FROM broadcast_run b JOIN streaming_stream s ON s.id=b.stream_id LEFT JOIN stream_buffer_policy p ON p.stream_id=s.id LEFT JOIN stream_dvr_policy d ON d.stream_id=s.id WHERE (p.policy->>'enabled'='true' OR (${config.dvrEnabled} AND d.policy->>'enabled'='true')) AND s.status='active' AND b.desired_state='running' AND b.state IN ('live','reconnecting') AND NOT EXISTS(SELECT 1 FROM recording r WHERE r.broadcast_id=b.id AND r.kind='buffer') ORDER BY b.created_at LIMIT 32`,
    );
    for (const r of runs)
      await run(`buffer:admit:${String(r.id)}`, () => admitBuffer(database, String(r.id), config));
  };
  const preparation = async () => {
    const clips = await database.execute(
      sql`SELECT c.id FROM clip_request c JOIN recording r ON r.id=c.recording_id WHERE c.prepared=false AND r.state='queued' AND r.next_attempt_at<=now() AND (r.leased_until IS NULL OR r.leased_until<=now()) ORDER BY r.next_attempt_at,c.created_at LIMIT 100`,
    );
    await maintenanceBatch(
      clips
        .filter((c) => run.available(`clip:prepare:${String(c.id)}`))
        .slice(0, config.maxClipJobs),
      (c) =>
        run(`clip:prepare:${String(c.id)}`, () =>
          prepareClip(database, String(c.id), config, store),
        ),
    );
  };
  const release = async () => {
    const clips = await database.execute(
      sql`SELECT r.id,r.state FROM clip_request c JOIN recording r ON r.id=c.recording_id WHERE c.pins_released=false AND r.state IN ('ready','failed','deleted','deleting') ORDER BY c.created_at LIMIT 100`,
    );
    await maintenanceBatch(clips, (r) =>
      run(`clip:release:${String(r.id)}`, () =>
        maintenanceTransaction(database, `clip:${String(r.id)}`, async (db) => {
          const recording = await getRecording(db, String(r.id), false, true);
          if (["ready", "failed", "deleted", "deleting"].includes(recording.state))
            await releaseClipInputs(db, recording.id);
        }),
      ),
    );
  };
  const evict = async () => {
    const buffers = await database.execute(
      sql`SELECT id FROM recording WHERE kind='buffer' AND state IN ('queued','recording','finalizing','ready','failed') ORDER BY storage_metered_at,id LIMIT 32`,
    );
    await maintenanceBatch(buffers, (r) =>
      run(`buffer:evict:${String(r.id)}`, () => evictBuffer(database, String(r.id), store)),
    );
  };
  const tasks = [
    { name: "clips:deadlines", work: deadlines },
    { name: "buffers:admission", work: admission },
    { name: "dvr:sync", work: () => syncDvrWindows(database, config, run) },
    { name: "clips:preparation", work: preparation },
    { name: "clips:release-inputs", work: release },
    { name: "buffers:eviction", work: evict },
  ].map(({ name, work }) => {
    let running: Promise<void> | undefined;
    const timer = setInterval(() => {
      running ??= run(name, work).finally(() => {
        running = undefined;
      });
    }, 3000);
    timer.unref();
    return { stop: () => clearInterval(timer), pending: () => running };
  });
  return async () => {
    for (const task of tasks) task.stop();
    await Promise.all(tasks.map((task) => task.pending()));
  };
}
