import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { recording, recordingSegment } from "./recording.js";
import { streamingStream } from "./streaming.js";
interface RollingBufferPolicy {
  enabled: boolean;
  durationSeconds: number;
  maxBytes: number;
  consentAcknowledged: boolean;
}
export const streamBufferPolicy = pgTable("stream_buffer_policy", {
  streamId: text("stream_id")
    .primaryKey()
    .references(() => streamingStream.id),
  policy: jsonb("policy").$type<RollingBufferPolicy>().notNull(),
  version: integer("version").notNull().default(1),
});
export const clipRequest = pgTable(
  "clip_request",
  {
    id: text("id").primaryKey(),
    sourceRecordingId: text("source_recording_id")
      .notNull()
      .references(() => recording.id),
    recordingId: text("recording_id")
      .notNull()
      .unique()
      .references(() => recording.id),
    label: text("label").notNull().default(""),
    cutMode: text("cut_mode").notNull(),
    requestedStartSeconds: doublePrecision("requested_start_seconds").notNull(),
    requestedEndSeconds: doublePrecision("requested_end_seconds").notNull(),
    resolvedStartSeconds: doublePrecision("resolved_start_seconds").notNull(),
    resolvedEndSeconds: doublePrecision("resolved_end_seconds").notNull(),
    published: boolean("published").notNull().default(false),
    prepared: boolean("prepared").notNull().default(false),
    pinsReleased: boolean("pins_released").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("clip_cut_mode_check", sql`${t.cutMode} IN ('keyframe','precise')`),
    index("clip_source_idx").on(t.sourceRecordingId),
    check(
      "clip_interval_check",
      sql`${t.requestedEndSeconds}>${t.requestedStartSeconds} AND ${t.resolvedEndSeconds}>${t.resolvedStartSeconds}`,
    ),
  ],
);
export const clipSegmentPin = pgTable(
  "clip_segment_pin",
  {
    clipId: text("clip_id")
      .notNull()
      .references(() => clipRequest.id),
    recordingId: text("recording_id").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clipId, t.position] }),
    foreignKey({
      columns: [t.recordingId, t.position],
      foreignColumns: [recordingSegment.recordingId, recordingSegment.position],
    }),
    index("clip_pin_source_idx").on(t.recordingId, t.position),
  ],
);
