import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  doublePrecision,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { streamingStream, streamingSession } from "./streaming.js";

export const broadcastRun = pgTable(
  "broadcast_run",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    state: text("state").notNull().default("created"),
    desiredState: text("desired_state").notNull().default("idle"),
    version: integer("version").notNull().default(1),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    terminalState: text("terminal_state").notNull().default("stopped"),
    outputSeconds: doublePrecision("output_seconds").notNull().default(0),
    runSeconds: doublePrecision("run_seconds").notNull().default(0),
    egressBytes: doublePrecision("egress_bytes").notNull().default(0),
    transcodeSeconds: doublePrecision("transcode_seconds").notNull().default(0),
    reservationSeconds: doublePrecision("reservation_seconds").notNull().default(0),
    usageSamples: integer("usage_samples").notNull().default(0),
    partialSamples: integer("partial_samples").notNull().default(0),
    sourceSessionId: text("source_session_id").references(() => streamingSession.id),
    sourceGeneration: integer("source_generation"),
    waitTimeoutSeconds: integer("wait_timeout_seconds").notNull(),
    maxDurationSeconds: integer("max_duration_seconds").notNull(),
    lastError: text("last_error"),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startRequestedAt: timestamp("start_requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    sourceLostAt: timestamp("source_lost_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("broadcast_run_scope_idx").on(t.projectId, t.environmentId, t.id),
    index("broadcast_run_stream_recent_idx").on(
      t.projectId,
      t.environmentId,
      t.streamId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("broadcast_run_stream_active_idx")
      .on(t.projectId, t.environmentId, t.streamId, t.createdAt.desc(), t.id.desc())
      .where(
        sql`${t.desiredState}='running' AND ${t.state} NOT IN ('stopping','stopped','failed')`,
      ),
    unique("broadcast_run_source_identity").on(t.id, t.streamId),
  ],
);
export const broadcastOutput = pgTable("broadcast_output", {
  id: text("id").primaryKey(),
  broadcastId: text("broadcast_id")
    .notNull()
    .references(() => broadcastRun.id),
  kind: text("kind").notNull(),
  destinationId: text("destination_id"),
  credentialVersion: integer("credential_version"),
  encryptedSecret: text("encrypted_secret"),
  configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull(),
});
export const broadcastJob = pgTable(
  "broadcast_job",
  {
    id: text("id").primaryKey(),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => broadcastRun.id),
    outputId: text("output_id")
      .notNull()
      .references(() => broadcastOutput.id),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("queued"),
    desiredState: text("desired_state").notNull().default("running"),
    fence: integer("fence").notNull().default(0),
    manualRetries: integer("manual_retries").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    egressBytes: doublePrecision("egress_bytes").notNull().default(0),
    observedBytes: doublePrecision("observed_bytes").notNull().default(0),
    bitrate: doublePrecision("bitrate").notNull().default(0),
    droppedFrames: doublePrecision("dropped_frames").notNull().default(0),
    observedDropped: doublePrecision("observed_dropped").notNull().default(0),
    outputSeconds: doublePrecision("output_seconds").notNull().default(0),
    transcodeSeconds: doublePrecision("transcode_seconds").notNull().default(0),
    workerId: text("worker_id"),
    leaseToken: text("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    sampleSequence: integer("sample_sequence").notNull().default(0),
    observedLive: integer("observed_live").notNull().default(0),
    lastError: text("last_error"),
    sourceSessionId: text("source_session_id").references(() => streamingSession.id),
    sourceGeneration: integer("source_generation"),
  },
  (t) => [index("broadcast_job_claim_idx").on(t.availableAt, t.leasedUntil)],
);
export const broadcastAttempt = pgTable(
  "broadcast_attempt",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => broadcastJob.id),
    fence: integer("fence").notNull(),
    workerId: text("worker_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.fence] })],
);
export const broadcastReservation = pgTable("broadcast_reservation", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => broadcastJob.id),
  fence: integer("fence").notNull(),
  workerId: text("worker_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const broadcastUsageSample = pgTable(
  "broadcast_usage_sample",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => broadcastJob.id),
    fence: integer("fence").notNull(),
    sequence: integer("sequence").notNull(),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => broadcastRun.id),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    outputSeconds: doublePrecision("output_seconds").notNull(),
    egressBytes: doublePrecision("egress_bytes").notNull().default(0),
    transcodeSeconds: doublePrecision("transcode_seconds").notNull().default(0),
    reservationSeconds: doublePrecision("reservation_seconds").notNull(),
    coverage: text("coverage").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.fence, t.sequence] }),
    index("broadcast_usage_scope_idx").on(t.projectId, t.environmentId, t.occurredAt),
    index("broadcast_usage_run_idx").on(t.broadcastId, t.occurredAt),
  ],
);
