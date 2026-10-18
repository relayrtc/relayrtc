import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  unique,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { streamingStream } from "./streaming.js";
import { broadcastRun } from "./broadcast.js";
const instant = (name: string) => timestamp(name, { withTimezone: true });
export const streamRecordingPolicy = pgTable("stream_recording_policy", {
  streamId: text("stream_id")
    .primaryKey()
    .references(() => streamingStream.id),
  policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});
export const recording = pgTable(
  "recording",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("recording"),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => broadcastRun.id),
    assetId: text("asset_id").notNull().unique(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    state: text("state").notNull().default("queued"),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    partial: boolean("partial").notNull().default(false),
    lastError: text("last_error"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    fence: integer("fence").notNull().default(0),
    leaseToken: text("lease_token"),
    leasedUntil: instant("leased_until"),
    workerId: text("worker_id"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at").notNull().defaultNow(),
    heartbeatAt: instant("heartbeat_at"),
    sourceSessionId: text("source_session_id"),
    sourceGeneration: integer("source_generation"),
    sourceSequence: bigint("source_sequence", { mode: "number" }),
    durationSeconds: doublePrecision("duration_seconds").notNull().default(0),
    processingSeconds: doublePrecision("processing_seconds").notNull().default(0),
    storedBytes: bigint("stored_bytes", { mode: "number" }).notNull().default(0),
    storageByteSeconds: doublePrecision("storage_byte_seconds").notNull().default(0),
    storageMeteredAt: instant("storage_metered_at").notNull().defaultNow(),
    segmentCount: integer("segment_count").notNull().default(0),
    grantEpoch: integer("grant_epoch").notNull().default(1),
    eventSequence: integer("event_sequence").notNull().default(0),
    codecs: jsonb("codecs").$type<string[]>().notNull().default([]),
    exportFence: integer("export_fence"),
    mp4Parts: integer("mp4_parts").notNull().default(0),
    hasThumbnail: boolean("has_thumbnail").notNull().default(false),
    cleanupAfter: instant("cleanup_after"),
    cleanupCompleted: boolean("cleanup_completed").notNull().default(false),
    deletionRequestedAt: instant("deletion_requested_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    startedAt: instant("started_at"),
    endedAt: instant("ended_at"),
    expiresAt: instant("expires_at"),
  },
  (t) => [
    unique().on(t.id, t.streamId),
    unique().on(t.assetId, t.id),
    index("recording_scope_idx").on(t.projectId, t.environmentId, t.id),
    index("recording_retention_idx")
      .on(t.expiresAt)
      .where(sql`${t.state} NOT IN ('deleted','deleting')`),
    index("recording_cleanup_idx")
      .on(t.cleanupAfter)
      .where(sql`${t.cleanupCompleted}=false AND ${t.state} IN ('ready','failed')`),
    index("recording_due_idx").on(t.state, t.nextAttemptAt, t.leasedUntil),
    uniqueIndex("recording_active_run_idx")
      .on(t.broadcastId, t.kind)
      .where(sql`${t.state} IN ('queued','recording','finalizing') AND ${t.kind}<>'clip'`),
    check("recording_kind_check", sql`${t.kind} IN ('recording','buffer','clip')`),
    check(
      "recording_state_check",
      sql`${t.state} IN ('queued','recording','finalizing','ready','failed','deleting','deleted')`,
    ),
  ],
);
export const recordingObject = pgTable(
  "recording_object",
  {
    recordingId: text("recording_id")
      .notNull()
      .references(() => recording.id),
    name: text("name").notNull(),
    objectKey: text("object_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    fence: integer("fence").notNull(),
    committedAt: instant("committed_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    meteredAt: instant("metered_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.recordingId, t.name] }),
    check("recording_object_size_bytes_check", sql`${t.sizeBytes} BETWEEN 0 AND 16777216`),
  ],
);
export const recordingSegment = pgTable(
  "recording_segment",
  {
    recordingId: text("recording_id")
      .notNull()
      .references(() => recording.id),
    position: integer("position").notNull(),
    mediaStartSeconds: doublePrecision("media_start_seconds").notNull().default(0),
    sessionId: text("session_id").notNull(),
    generation: integer("generation").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    initName: text("init_name").notNull(),
    audioName: text("audio_name"),
    audioInitName: text("audio_init_name"),
    audioDurationSeconds: doublePrecision("audio_duration_seconds"),
    durationSeconds: doublePrecision("duration_seconds").notNull(),
    programDateTime: instant("program_date_time"),
    discontinuitySequence: integer("discontinuity_sequence").notNull().default(0),
    discontinuity: boolean("discontinuity").notNull().default(false),
    committedAt: instant("committed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.recordingId, t.position] }),
    unique().on(t.recordingId, t.sessionId, t.generation, t.sequence),
    foreignKey({
      columns: [t.recordingId, t.audioName],
      foreignColumns: [recordingObject.recordingId, recordingObject.name],
    }),
    foreignKey({
      columns: [t.recordingId, t.audioInitName],
      foreignColumns: [recordingObject.recordingId, recordingObject.name],
    }),
    foreignKey({
      columns: [t.recordingId, t.name],
      foreignColumns: [recordingObject.recordingId, recordingObject.name],
    }),
    foreignKey({
      columns: [t.recordingId, t.initName],
      foreignColumns: [recordingObject.recordingId, recordingObject.name],
    }),
  ],
);
export const recordingAccessGrant = pgTable(
  "recording_access_grant",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recording.id),
    tokenHash: text("token_hash").notNull(),
    action: text("action").notNull(),
    epoch: integer("epoch").notNull(),
    expiresAt: instant("expires_at").notNull(),
    revokedAt: instant("revoked_at"),
  },
  (t) => [index("recording_grant_expiry_idx").on(t.expiresAt)],
);
