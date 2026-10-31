import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { room } from "./room.js";

export const roomLifecycle = pgTable(
  "room_lifecycle",
  {
    roomId: text("room_id")
      .primaryKey()
      .references(() => room.id, { onDelete: "cascade" }),
    version: integer("version").default(1).notNull(),
    locked: boolean("locked").default(false).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    index("room_lifecycle_deadline_idx")
      .on(table.endsAt)
      .where(sql`${table.endsAt} IS NOT NULL AND ${table.settledAt} IS NULL`),
  ],
);

export const roomInvitation = pgTable(
  "room_invitation",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    identity: text("identity"),
    permissions: text("permissions").array().notNull(),
    maxUses: integer("max_uses").notNull(),
    uses: integer("uses").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("room_invitation_secret_idx").on(table.secretHash),
    index("room_invitation_room_idx").on(table.roomId, table.id),
  ],
);

export const roomInvitationRedemption = pgTable(
  "room_invitation_redemption",
  {
    participantId: text("participant_id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => roomInvitation.id, { onDelete: "cascade" }),
    redemptionId: text("redemption_id").notNull(),
    identity: text("identity").notNull(),
    claims: jsonb("claims").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("room_invitation_redemption_key_idx").on(table.invitationId, table.redemptionId),
  ],
);
