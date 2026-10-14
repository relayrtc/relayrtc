import { relations, sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { environment, project } from "./project.js";

export const apiKey = pgTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    prefix: text("prefix").notNull(),
    hashedSecret: text("hashed_secret").notNull(),
    scopes: text("scopes").array().default(sql`ARRAY[]::text[]`).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    index("api_key_project_id_idx").on(table.projectId),
    index("api_key_environment_id_idx").on(table.environmentId),
    index("api_key_active_idx").on(table.environmentId, table.revokedAt, table.expiresAt),
    uniqueIndex("api_key_prefix_idx").on(table.prefix),
    uniqueIndex("api_key_hashed_secret_idx").on(table.hashedSecret),
    foreignKey({
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environment.id, environment.projectId],
      name: "api_key_environment_project_fk",
    }).onDelete("cascade"),
    check("api_key_type_check", sql`${table.type} in ('publishable', 'secret')`),
    check(
      "api_key_publishable_scopes_check",
      sql`${table.type} = 'secret' or cardinality(${table.scopes}) = 0`,
    ),
    check(
      "api_key_expiration_check",
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const apiKeyRelations = relations(apiKey, ({ one }) => ({
  creator: one(user, {
    fields: [apiKey.createdBy],
    references: [user.id],
  }),
  environment: one(environment, {
    fields: [apiKey.environmentId, apiKey.projectId],
    references: [environment.id, environment.projectId],
  }),
  project: one(project, {
    fields: [apiKey.projectId],
    references: [project.id],
  }),
}));
