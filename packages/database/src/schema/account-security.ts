import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accountRequestLimit = pgTable("account_request_limit", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const accountEmailOutbox = pgTable("account_email_outbox", {
  id: text("id").primaryKey(),
  payload: text("payload"),
  subjectUserId: text("subject_user_id"),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (table) => [index("account_email_delivery_idx").on(table.availableAt).where(sql`${table.payload} is not null`)]);
