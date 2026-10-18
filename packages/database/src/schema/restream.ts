import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
  bigserial,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { streamingStream, streamingIngestCredential } from "./streaming.js";
export const restreamSource = pgTable(
  "restream_source",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    protocol: text("protocol").notNull(),
    host: text("host"),
    encryptedSecret: text("encrypted_secret"),
    version: integer("version").notNull().default(1),
    reconnectBudget: integer("reconnect_budget").notNull().default(3),
    maxDurationSeconds: integer("max_duration_seconds").notNull(),
    maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
    state: text("state").notNull().default("created"),
    lastError: text("last_error"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("restream_source_scope_idx").on(t.projectId, t.environmentId, t.id)],
);
export const restreamSession = pgTable(
  "restream_session",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => restreamSource.id),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    desiredState: text("desired_state").notNull().default("running"),
    attempts: integer("attempts").notNull().default(0),
    fence: integer("fence").notNull().default(0),
    leaseToken: text("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    credentialId: text("credential_id").references(() => streamingIngestCredential.id),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    sampleSequence: integer("sample_sequence").notNull().default(0),
    attemptFetchedBytes: bigint("attempt_fetched_bytes", { mode: "number" }).notNull().default(0),
    attemptProcessingSeconds: doublePrecision("attempt_processing_seconds").notNull().default(0),
    fetchedBytes: bigint("fetched_bytes", { mode: "number" }).notNull().default(0),
    processingSeconds: doublePrecision("processing_seconds").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("restream_session_lease_idx")
      .on(t.leaseToken)
      .where(sql`${t.leaseToken} IS NOT NULL`),
    index("restream_session_history_idx").on(t.sourceId, t.createdAt.desc()),
    index("restream_session_claim_idx")
      .on(t.availableAt, t.leasedUntil)
      .where(sql`${t.endedAt} IS NULL`),
    uniqueIndex("restream_session_active_idx")
      .on(t.sourceId)
      .where(sql`${t.endedAt} IS NULL`),
    uniqueIndex("restream_stream_active_idx")
      .on(t.streamId)
      .where(sql`${t.endedAt} IS NULL AND ${t.kind}<>'probe'`),
  ],
);

export const restreamHealth = pgTable(
  "restream_health",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => restreamSource.id),
    sessionId: text("session_id").references(() => restreamSession.id),
    state: text("state").notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("restream_health_source_idx").on(t.sourceId, t.id.desc())],
);
export const restreamUsage = pgTable(
  "restream_usage",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => restreamSession.id),
    fence: integer("fence").notNull(),
    sequence: integer("sequence").notNull(),
    fetchedBytes: bigint("fetched_bytes", { mode: "number" }).notNull(),
    processingSeconds: doublePrecision("processing_seconds").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.fence, t.sequence] })],
);
