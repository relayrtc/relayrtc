import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { broadcastRun } from "./broadcast.js";
import { streamingStream } from "./streaming.js";
import { room } from "./room.js";
export const streamGuestStage = pgTable(
  "stream_guest_stage",
  {
    broadcastId: text("broadcast_id")
      .primaryKey()
      .references(() => broadcastRun.id),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id),
    enabled: boolean("enabled").notNull().default(false),
    version: integer("version").notNull().default(1),
    maxGuests: integer("max_guests").notNull(),
    layout: text("layout").notNull().default("grid"),
  },
  (t) => [
    index("guest_stage_stream_idx").on(t.streamId),
    uniqueIndex("guest_stage_room_active_idx")
      .on(t.roomId)
      .where(sql`${t.enabled}`),
    check("stream_guest_stage_max_guests_check", sql`${t.maxGuests} BETWEEN 1 AND 3`),
    check("stream_guest_stage_layout_check", sql`${t.layout} IN ('single','grid','pip')`),
  ],
);
export const streamAudience = pgTable(
  "stream_audience",
  {
    id: text("id").primaryKey(),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => streamGuestStage.broadcastId),
    subject: text("subject").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    delegations: jsonb("delegations").notNull().default([]),
    epoch: integer("epoch").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now()+interval '1 hour'`),
  },
  (t) => [
    unique("stream_audience_broadcast_id_subject_key").on(t.broadcastId, t.subject),
    index("audience_expiry_idx").on(t.expiresAt),
    check(
      "stream_audience_role_check",
      sql`${t.role} IN ('host','cohost','moderator','guest','viewer')`,
    ),
  ],
);
export const streamGuest = pgTable(
  "stream_guest",
  {
    id: text("id").primaryKey(),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => streamGuestStage.broadcastId),
    subject: text("subject").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("pending"),
    media: jsonb("media").notNull(),
    mutedAudio: boolean("muted_audio").notNull().default(false),
    mutedVideo: boolean("muted_video").notNull().default(false),
    version: integer("version").notNull().default(1),
    participantId: text("participant_id").unique(),
    actorId: text("actor_id").notNull(),
    decidedBy: text("decided_by"),
    eventSequence: integer("event_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastJoinedAt: timestamp("last_joined_at", { withTimezone: true }),
  },
  (t) => [
    index("guest_run_created_idx").on(t.broadcastId, t.id.desc()),
    uniqueIndex("guest_subject_open_idx")
      .on(t.broadcastId, t.subject)
      .where(sql`${t.state} IN ('pending','accepted','approved','joined')`),
    check("stream_guest_kind_check", sql`${t.kind} IN ('invite','request')`),
    check(
      "stream_guest_state_check",
      sql`${t.state} IN ('pending','accepted','declined','approved','rejected','cancelled','expired','joined','left','removed')`,
    ),
    index("guest_expiry_idx").on(t.state, t.expiresAt),
  ],
);
export const streamGuestGrant = pgTable(
  "stream_guest_grant",
  {
    tokenId: text("token_id").primaryKey(),
    guestId: text("guest_id")
      .notNull()
      .references(() => streamGuest.id),
    participantId: text("participant_id").notNull(),
    version: integer("version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("guest_grant_expiry_idx").on(t.expiresAt),
    index("guest_grant_guest_idx").on(t.guestId, t.version, t.expiresAt),
  ],
);
