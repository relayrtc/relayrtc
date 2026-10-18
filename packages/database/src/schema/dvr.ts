import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  bigint,
  primaryKey,
  foreignKey,
  index,
  check,
} from "drizzle-orm/pg-core";
interface DvrPolicy {
  enabled: boolean;
  durationSeconds: number;
  maxBytes: number;
  endedRetentionSeconds: number;
  consentAcknowledged: true;
}
import { streamingStream } from "./streaming.js";
import { recording, recordingSegment } from "./recording.js";
export const streamDvrPolicy = pgTable(
  "stream_dvr_policy",
  {
    streamId: text("stream_id")
      .primaryKey()
      .references(() => streamingStream.id),
    policy: jsonb("policy").$type<DvrPolicy>().notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [check("stream_dvr_policy_version_check", sql`${t.version}>0`)],
);
export const dvrWindow = pgTable(
  "dvr_window",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .unique()
      .references(() => recording.id),
    policy: jsonb("policy").$type<DvrPolicy>().notNull(),
    policyVersion: integer("policy_version").notNull(),
    state: text("state").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    endPosition: integer("end_position"),
    eventSequence: integer("event_sequence").notNull().default(0),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastStart: integer("last_start").notNull().default(-1),
    lastEnd: integer("last_end").notNull().default(-1),
    deliveredBytes: bigint("delivered_bytes", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    index("dvr_window_state_idx").on(t.state, t.expiresAt),
    check("dvr_window_policy_version_check", sql`${t.policyVersion}>0`),
    check("dvr_window_state_check", sql`${t.state} IN ('active','draining','disabled')`),
    check("dvr_window_delivered_bytes_check", sql`${t.deliveredBytes}>=0`),
  ],
);
export const dvrSegmentPin = pgTable(
  "dvr_segment_pin",
  {
    recordingId: text("recording_id").notNull(),
    position: integer("position").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordingId, t.position] }),
    foreignKey({
      columns: [t.recordingId, t.position],
      foreignColumns: [recordingSegment.recordingId, recordingSegment.position],
    }),
    index("dvr_pin_expiry_idx").on(t.expiresAt),
  ],
);
export const dvrDeliveryUsage = pgTable(
  "dvr_delivery_usage",
  {
    id: text("id").primaryKey(),
    windowId: text("window_id")
      .notNull()
      .references(() => dvrWindow.id),
    bytes: integer("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dvr_delivery_retention_idx").on(t.createdAt),
    check("dvr_delivery_usage_bytes_check", sql`${t.bytes}>=0`),
  ],
);
