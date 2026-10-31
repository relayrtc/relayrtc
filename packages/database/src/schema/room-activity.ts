import { boolean, integer, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { room } from "./room.js";
import { participant } from "./participant.js";

export const roomActivityPolicy = pgTable("room_activity_policy", {
  roomId: text("room_id")
    .primaryKey()
    .references(() => room.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  activityEnabled: boolean("activity_enabled").notNull().default(true),
  speakersEnabled: boolean("speakers_enabled").notNull().default(true),
  idleSeconds: integer("idle_seconds").notNull().default(120),
  heartbeatSeconds: integer("heartbeat_seconds").notNull().default(45),
});
export const participantActivity = pgTable("participant_activity", {
  participantId: text("participant_id")
    .primaryKey()
    .references(() => participant.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("auto"),
  shareActivity: boolean("share_activity").notNull().default(true),
  shareSpeaking: boolean("share_speaking").notNull().default(true),
  visible: boolean("visible").notNull().default(true),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  lastInputAt: timestamp("last_input_at", { withTimezone: true }),
});
export const roomSpeakerSnapshot = pgTable(
  "room_speaker_snapshot",
  {
    roomId: text("room_id")
      .primaryKey()
      .references(() => room.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    speakers: jsonb("speakers").$type<readonly { sessionId: string; level: number }[]>().notNull(),
    dominantSessionId: text("dominant_session_id"),
  },
  (table) => [index("room_speaker_snapshot_expiry_idx").on(table.observedAt)],
);
