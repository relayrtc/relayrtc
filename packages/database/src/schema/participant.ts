import { relations, sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  uniqueIndex,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { room } from "./room.js";

export const participant = pgTable(
  "participant",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    name: text("name").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    role: text("role").default("participant").notNull(),
    accessVersion: integer("access_version").default(1).notNull(),
    allowedPermissions: text("allowed_permissions").array(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("participant_room_host_idx").on(table.roomId).where(sql`${table.role} = 'host' and ${table.removedAt} is null`),
    check("participant_access_version_check", sql`${table.accessVersion} > 0`),
    check("participant_allowed_permissions_check", sql`${table.allowedPermissions} is null or (${table.allowedPermissions} <@ ARRAY['room:join','audio:publish','video:publish','screen:publish','messages:send','metadata:update']::text[] and 'room:join' = any(${table.allowedPermissions}) and cardinality(${table.allowedPermissions}) <= 6 and array_position(${table.allowedPermissions},NULL) is null)`),
    index("participant_room_joined_at_idx").on(table.roomId, table.joinedAt),
    index("participant_room_left_at_idx").on(table.roomId, table.leftAt),
    index("participant_room_activity_idx").on(table.roomId, table.id).where(sql`${table.leftAt} IS NULL AND ${table.removedAt} IS NULL`),
    check(
      "participant_left_at_check",
      sql`${table.leftAt} is null or ${table.leftAt} >= ${table.joinedAt}`,
    ),
  ],
);

export const participantRelations = relations(participant, ({ one }) => ({
  room: one(room, {
    fields: [participant.roomId],
    references: [room.id],
  }),
}));

export const participantSession = pgTable(
  "participant_session",
  {
    id: text("id").primaryKey(),
    participantId: text("participant_id")
      .notNull()
      .references(() => participant.id, { onDelete: "cascade" }),
    signalingNodeId: text("signaling_node_id").notNull(),
    signalingInstanceId: text("signaling_instance_id"),
    mediaNodeId: text("media_node_id"),
    connectionState: text("connection_state").default("connected").notNull(),
    transportType: text("transport_type").default("tcp").notNull(),
    clientIp: text("client_ip"),
    countryCode: text("country_code"),
    country: text("country"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    reconnectedAt: timestamp("reconnected_at", { withTimezone: true }),
    messagesIn: integer("messages_in").default(0).notNull(),
    messagesOut: integer("messages_out").default(0).notNull(),
    connectionSeconds: doublePrecision("connection_seconds").default(0).notNull(),
    meteringStartedAt: timestamp("metering_started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("participant_session_participant_id_idx").on(table.participantId),
    index("participant_session_node_state_idx").on(table.signalingNodeId, table.connectionState),
    index("participant_session_country_idx").on(table.country),
    check(
      "participant_session_connection_state_check",
      sql`${table.connectionState} in ('connecting', 'connected', 'reconnecting', 'disconnected', 'failed')`,
    ),
    check(
      "participant_session_transport_type_check",
      sql`${table.transportType} in ('udp', 'tcp', 'tls')`,
    ),
  ],
);

export const participantSessionRelations = relations(participantSession, ({ one }) => ({
  participant: one(participant, {
    fields: [participantSession.participantId],
    references: [participant.id],
  }),
}));

export const participantConnectionInterval = pgTable(
  "participant_connection_interval",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    sessionId: text("session_id")
      .notNull()
      .references(() => participantSession.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("participant_connection_interval_session_time_idx").on(table.sessionId, table.startedAt),
    uniqueIndex("participant_connection_interval_open_idx")
      .on(table.sessionId)
      .where(sql`${table.endedAt} is null`),
    check(
      "participant_connection_interval_time_check",
      sql`${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const signalingUsageSample = pgTable(
  "signaling_usage_sample",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => participantSession.id, { onDelete: "cascade" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("signaling_usage_sample_session_idx").on(table.sessionId)],
);
