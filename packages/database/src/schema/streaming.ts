import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { mixer } from "./mixer.js";

export const streamingStream = pgTable(
  "streaming_stream",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    source: jsonb("source").$type<Record<string, unknown>>().notNull(),
    profile: jsonb("profile").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    playbackEpoch: integer("playback_epoch").notNull().default(1),
    maxDurationSeconds: integer("max_duration_seconds").notNull(),
    retentionSeconds: integer("retention_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("streaming_stream_scope_idx").on(t.projectId, t.environmentId, t.id)],
);
export const streamingSession = pgTable(
  "streaming_session",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    state: text("state").notNull().default("starting"),
    desiredState: text("desired_state").notNull().default("running"),
    generation: integer("generation").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    guestStage: boolean("guest_stage").notNull().default(false),
    mixerId: text("mixer_id").references((): AnyPgColumn => mixer.id),
    leaseToken: text("lease_token"),
    workerId: text("worker_id"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    ingressId: text("ingress_id"),
    ingressType: text("ingress_type"),
    ingressCredentialId: text("ingress_credential_id").references(
      () => streamingIngestCredential.id,
    ),
    whipResource: text("whip_resource"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastError: text("last_error"),
    sourceInfo: jsonb("source_info")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ tracks: [] }),
    ingressBitrate: bigint("ingress_bitrate", { mode: "number" }).notNull().default(0),
    programBitrate: bigint("program_bitrate", { mode: "number" }).notNull().default(0),
    ingressBytes: bigint("ingress_bytes", { mode: "number" }).notNull().default(0),
    programBytes: bigint("program_bytes", { mode: "number" }).notNull().default(0),
    sampleSequence: integer("sample_sequence").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("streaming_session_active_idx")
      .on(t.streamId)
      .where(sql`${t.state} NOT IN ('ended','failed')`),
    index("streaming_session_claim_idx")
      .on(t.availableAt, t.leasedUntil)
      .where(sql`${t.state} NOT IN ('ended','failed')`),
  ],
);
export const streamingIngestCredential = pgTable(
  "streaming_ingest_credential",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    secretHash: text("secret_hash").notNull().unique(),
    scheduleId: text("schedule_id"),
    notBefore: timestamp("not_before", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("streaming_ingest_stream_idx").on(t.streamId)],
);
export const streamingOperation = pgTable("streaming_operation", {
  id: text("id").primaryKey(),
  streamId: text("stream_id")
    .notNull()
    .references(() => streamingStream.id),
  sessionId: text("session_id").references(() => streamingSession.id),
  broadcastId: text("broadcast_id"),
  outputId: text("output_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const streamingIdempotency = pgTable(
  "streaming_idempotency",
  {
    scopeKey: text("scope_key").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    response: jsonb("response").notNull(),
    status: integer("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    primaryKey({ columns: [t.scopeKey, t.key] }),
    index("streaming_idempotency_expiry_idx").on(t.expiresAt),
  ],
);
export const streamingObject = pgTable(
  "streaming_object",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => streamingSession.id),
    name: text("name").notNull(),
    objectKey: text("object_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    referencedNames: text("referenced_names")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.name] }),
    index("streaming_object_expiry_idx").on(t.expiresAt),
  ],
);
export const streamingUsageSample = pgTable(
  "streaming_usage_sample",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => streamingSession.id),
    generation: integer("generation").notNull(),
    sequence: integer("sequence").notNull(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    sourceSeconds: doublePrecision("source_seconds").notNull(),
    ingressBytes: bigint("ingress_bytes", { mode: "number" }).notNull(),
    programBytes: bigint("program_bytes", { mode: "number" }).notNull(),
    coverage: text("coverage").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.generation, t.sequence] }),
    index("streaming_usage_scope_idx").on(t.projectId, t.environmentId, t.endAt),
  ],
);
