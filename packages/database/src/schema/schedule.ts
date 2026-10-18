import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, index, primaryKey, unique } from "drizzle-orm/pg-core";
import { streamingStream, streamingOperation } from "./streaming.js";
import { broadcastRun } from "./broadcast.js";
const date = (name: string) => timestamp(name, { withTimezone: true });
export const broadcastSchedule = pgTable(
  "broadcast_schedule",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    broadcastId: text("broadcast_id")
      .notNull()
      .unique()
      .references(() => broadcastRun.id),
    operationId: text("operation_id").notNull(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    creatorType: text("creator_type").notNull(),
    creatorId: text("creator_id").notNull(),
    state: text("state").notNull().default("scheduled"),
    version: integer("version").notNull().default(1),
    grantEpoch: integer("grant_epoch").notNull().default(1),
    eventSequence: integer("event_sequence").notNull().default(0),
    sourceDeadline: date("source_deadline"),
    startsAt: date("starts_at").notNull(),
    endsAt: date("ends_at").notNull(),
    timeZone: text("time_zone").notNull(),
    sourceWaitSeconds: integer("source_wait_seconds").notNull(),
    catchUpSeconds: integer("catch_up_seconds").notNull(),
    publisherEarlySeconds: integer("publisher_early_seconds").notNull(),
    viewerEarlySeconds: integer("viewer_early_seconds").notNull(),
    viewerAfterSeconds: integer("viewer_after_seconds").notNull(),
    notifyBeforeSeconds: integer("notify_before_seconds"),
    fence: integer("fence").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leasedUntil: date("leased_until"),
    nextAttemptAt: date("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
    startedAt: date("started_at"),
    endedAt: date("ended_at"),
  },
  (t) => [
    unique().on(t.id, t.streamId),
    index("broadcast_schedule_scope_idx").on(t.projectId, t.environmentId, t.id),
    index("broadcast_schedule_due_idx")
      .on(t.startsAt, t.nextAttemptAt)
      .where(sql`${t.state}='scheduled'`),
  ],
);
export const scheduleAttempt = pgTable(
  "schedule_attempt",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => broadcastSchedule.id),
    fence: integer("fence").notNull(),
    leaseToken: text("lease_token").notNull(),
    state: text("state").notNull(),
    reason: text("reason"),
    createdAt: date("created_at").notNull().defaultNow(),
    endedAt: date("ended_at"),
  },
  (t) => [primaryKey({ columns: [t.scheduleId, t.fence] })],
);
export const scheduleOperation = pgTable("schedule_operation", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id")
    .notNull()
    .references(() => broadcastSchedule.id),
  broadcastId: text("broadcast_id")
    .notNull()
    .references(() => broadcastRun.id),
  broadcastOperationId: text("broadcast_operation_id").references(() => streamingOperation.id),
  status: text("status").notNull().default("pending"),
  errorCode: text("error_code"),
  createdAt: date("created_at").notNull().defaultNow(),
  completedAt: date("completed_at"),
});
export const scheduleViewerGrant = pgTable(
  "schedule_viewer_grant",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => broadcastSchedule.id),
    tokenHash: text("token_hash").notNull(),
    epoch: integer("epoch").notNull(),
    expiresAt: date("expires_at").notNull(),
    revokedAt: date("revoked_at"),
  },
  (t) => [index("schedule_grant_expiry_idx").on(t.expiresAt)],
);
export const scheduleNotification = pgTable(
  "schedule_notification",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => broadcastSchedule.id),
    version: integer("version").notNull(),
    dueAt: date("due_at").notNull(),
    state: text("state").notNull().default("pending"),
    emittedAt: date("emitted_at"),
  },
  (t) => [
    unique().on(t.scheduleId, t.version),
    index("schedule_notification_due_idx")
      .on(t.dueAt)
      .where(sql`${t.state}='pending'`),
  ],
);
