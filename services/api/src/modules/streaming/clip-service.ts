import type { ClipResource } from "@relayrtc/types";
import { createClipSchema, recordingPolicySchema } from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getRecording } from "./recording-service.js";
import { id, conflict, missing, type Transaction, type StreamRow } from "./repository.js";
import type { StreamingConfig } from "./config.js";
import {
  clipPreparationMaxAttempts,
  clipPreparationTimeoutMs,
  clipRenderingTimeoutMs,
} from "./clip-progress.js";

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
  const preparing = r.state === "queued";
  const [objects] = preparing
    ? await db.execute(
        sql`SELECT (SELECT count(*)::int FROM recording_object WHERE recording_id=${r.id} AND committed_at IS NOT NULL) AS copied,(SELECT count(DISTINCT n.name)::int FROM clip_segment_pin p JOIN recording_segment s ON s.recording_id=p.recording_id AND s.position=p.position CROSS JOIN LATERAL (VALUES (s.name),(s.init_name),(s.audio_name),(s.audio_init_name)) AS n(name) WHERE p.clip_id=${c.id} AND n.name IS NOT NULL) AS total`,
      )
    : [];
  const stage =
    r.state === "finalizing"
      ? "rendering"
      : r.state === "recording"
        ? "queued"
        : preparing && r.lease_token && r.leased_until && r.leased_until.getTime() > Date.now()
          ? "preparing"
          : r.state;
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
    resolvedStartSeconds:
      r.state === "ready" && c.cut_mode === "precise"
        ? c.requested_start_seconds
        : c.resolved_start_seconds,
    resolvedEndSeconds:
      r.state === "ready" && c.cut_mode === "precise"
        ? c.requested_start_seconds + r.duration_seconds
        : c.resolved_end_seconds,
    durationSeconds: r.duration_seconds,
    published: c.published,
    lastError: r.last_error,
    storedBytes: r.stored_bytes,
    processingSeconds: r.processing_seconds,
    storageByteSeconds: r.storage_byte_seconds,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at?.toISOString() ?? null,
    progress: {
      stage,
      copiedObjects: Number(objects?.copied ?? 0),
      totalObjects: Number(objects?.total ?? 0),
      attempts: r.attempts,
      maxAttempts: clipPreparationMaxAttempts,
      nextAttemptAt:
        ["queued", "finalizing"].includes(r.state) &&
        r.next_attempt_at &&
        r.next_attempt_at.getTime() > Date.now()
          ? r.next_attempt_at.toISOString()
          : null,
      deadlineAt: preparing
        ? new Date(r.created_at.getTime() + clipPreparationTimeoutMs).toISOString()
        : r.state === "finalizing"
          ? new Date((r.ended_at ?? r.created_at).getTime() + clipRenderingTimeoutMs).toISOString()
          : null,
    },
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

export { registerClipMaintenance } from "./clip-maintenance.js";
