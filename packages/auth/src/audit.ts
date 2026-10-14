import { randomUUID } from "node:crypto";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";

export type AuditDatabase = Pick<RelayKitDatabase, "insert" | "execute">;
export interface AuditActor {
  type: "USER" | "SYSTEM" | "API_KEY" | "ANONYMOUS";
  id?: string | null | undefined;
  name: string;
}
export interface AuditRecord {
  actor: AuditActor;
  action: string;
  outcome: "SUCCESS" | "FAILURE" | "ATTEMPT";
  resourceType: string;
  resourceId?: string | null | undefined;
  organizationId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  correlationId?: string | null | undefined;
  // Only approved operational fields; never pass request bodies or credentials.
  metadata?: { status?: number; method?: string; provider?: string; notification?: string };
}

export async function recordAudit(database: AuditDatabase, record: AuditRecord) {
  await database.insert(schema.auditEvent).values({
    id: randomUUID(), actorType: record.actor.type,
    actorId: record.actor.id ?? null, actorName: record.actor.name.slice(0, 200),
    subjectUserId: record.subjectUserId ?? null, organizationId: record.organizationId ?? null,
    action: record.action.slice(0, 160), outcome: record.outcome,
    resourceType: record.resourceType, resourceId: record.resourceId ?? null,
    correlationId: record.correlationId ?? null, metadata: record.metadata ?? {},
  });
}

// Must be called inside a transaction; SET LOCAL cannot leak to another request.
export async function setAuditContext(database: AuditDatabase, actor: AuditActor, correlationId?: string) {
  await database.execute(sql`SELECT
    set_config('relayrtc.audit_actor_type', ${actor.type}, true),
    set_config('relayrtc.audit_actor_id', ${actor.id ?? ""}, true),
    set_config('relayrtc.audit_actor_name', ${actor.name.slice(0, 200)}, true),
    set_config('relayrtc.audit_correlation_id', ${correlationId ?? ""}, true)`);
}

export async function setUserAuditContext(database: AuditDatabase, userId: string) {
  await database.execute(sql`SELECT
    set_config('relayrtc.audit_actor_type', 'USER', true),
    set_config('relayrtc.audit_actor_id', ${userId}, true),
    set_config('relayrtc.audit_actor_name', coalesce((SELECT name FROM "user" WHERE id = ${userId}), 'User'), true)`);
}
