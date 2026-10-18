import { integer, pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { streamingStream } from "./streaming.js";
export const streamDestination = pgTable(
  "stream_destination",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    name: text("name").notNull(),
    host: text("host").notNull(),
    protocol: text("protocol").notNull(),
    port: integer("port").notNull(),
    profile: text("profile").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    credentialVersion: integer("credential_version").notNull().default(1),
    encryptedSecret: text("encrypted_secret"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stream_destination_scope_idx").on(t.streamId, t.id)],
);
