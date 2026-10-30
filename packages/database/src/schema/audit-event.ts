import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Deliberately no foreign keys: deletion must not erase retained accountability.
export const auditEvent = pgTable("audit_event", {
  id: text("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name").notNull(),
  subjectUserId: text("subject_user_id"),
  organizationId: text("organization_id"),
  roomId: text("room_id"),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  action: text("action").notNull(),
  outcome: text("outcome").notNull(),
  correlationId: text("correlation_id"),
  metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>().default({}).notNull(),
}, (table) => [
  index("audit_resource_idx").on(table.resourceType, table.resourceId, table.occurredAt, table.id),
  index("audit_room_idx").on(table.roomId, table.occurredAt, table.id),
  index("audit_personal_idx").on(table.subjectUserId, table.occurredAt, table.id),
  index("audit_organization_idx").on(table.organizationId, table.occurredAt, table.id),
  index("audit_retention_idx").on(table.occurredAt),
]);
