import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const time = (name: string) => timestamp(name, { withTimezone: true });
export const serviceUsageSample = pgTable(
  "service_usage_sample",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    streamId: text("stream_id").notNull(),
    runId: text("run_id").notNull(),
    actorKey: text("actor_key"),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
    counters: jsonb("counters").$type<Record<string, number>>().notNull().default({}),
    revision: integer("revision").notNull().default(0),
    corrections: jsonb("corrections").$type<Record<string, unknown>[]>().notNull().default([]),
    startedAt: time("started_at").notNull(),
    endedAt: time("ended_at").notNull(),
    occurredAt: time("occurred_at").notNull().defaultNow(),
    coverage: text("coverage").notNull(),
  },
  (t) => [
    index("service_usage_scope_idx").on(t.organizationId, t.projectId, t.environmentId, t.endedAt),
    index("service_usage_resource_idx").on(t.resourceType, t.resourceId, t.endedAt),
    index("service_usage_actor_idx").on(t.actorKey, t.endedAt),
    check("service_usage_window_check", sql`${t.endedAt} >= ${t.startedAt}`),
    check(
      "service_usage_coverage_check",
      sql`${t.coverage} IN ('observed','estimated','partial','unavailable')`,
    ),
  ],
);

export const serviceUsageObject = pgTable(
  "service_usage_object",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    streamId: text("stream_id").notNull(),
    sizeBytes: doublePrecision("size_bytes").notNull(),
    openedAt: time("opened_at").notNull(),
    removedAt: time("removed_at"),
  },
  (t) => [
    index("service_usage_object_scope_idx").on(t.organizationId, t.projectId, t.environmentId),
    index("service_usage_object_owner_idx").on(t.resourceId, t.removedAt),
    check("service_usage_object_bytes_check", sql`${t.sizeBytes} >= 0`),
  ],
);

export const serviceUsageActivation = pgTable("service_usage_activation", {
  id: text("id").primaryKey(),
  startedAt: time("started_at").notNull().defaultNow(),
  retainedFrom: time("retained_from"),
});
