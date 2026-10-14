import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";

export const auditQuery = z.object({
  cursor: z.string().max(512).optional(),
  action: z.string().trim().max(160).optional(),
  actorType: z.enum(["USER", "SYSTEM", "API_KEY", "ANONYMOUS"]).optional(),
  outcome: z.enum(["SUCCESS", "FAILURE", "ATTEMPT"]).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export async function listAuditEvents(database: RelayKitDatabase, scope: { userId: string; organizationId?: string }, query: z.infer<typeof auditQuery>) {
  if (scope.organizationId) {
    const [membership] = await database.select({ role: schema.member.role }).from(schema.member).where(and(
      eq(schema.member.userId, scope.userId), eq(schema.member.organizationId, scope.organizationId),
    ));
    if (!membership?.role.split(",").some((role) => ["owner", "admin"].includes(role.trim()))) {
      throw new ApiError(403, "AUDIT_ACCESS_DENIED", "Only organization owners and administrators can view this audit history.");
    }
  }
  const filters = [scope.organizationId ? eq(schema.auditEvent.organizationId, scope.organizationId)
    : and(eq(schema.auditEvent.subjectUserId, scope.userId), eq(schema.auditEvent.resourceType, "user"))];
  // Personal security records include auth DB mutations, but never tenant events.
  if (!scope.organizationId) filters[0] = and(eq(schema.auditEvent.subjectUserId, scope.userId),
    or(eq(schema.auditEvent.resourceType, "user"), eq(schema.auditEvent.resourceType, "account"),
      eq(schema.auditEvent.resourceType, "session"), eq(schema.auditEvent.resourceType, "two_factor")));
  if (query.action) filters.push(eq(schema.auditEvent.action, query.action));
  if (query.actorType) filters.push(eq(schema.auditEvent.actorType, query.actorType));
  if (query.outcome) filters.push(eq(schema.auditEvent.outcome, query.outcome));
  if (query.from) filters.push(gt(schema.auditEvent.occurredAt, new Date(query.from)));
  if (query.to) filters.push(lt(schema.auditEvent.occurredAt, new Date(query.to)));
  if (query.cursor) {
    const decoded = z.object({ at: z.iso.datetime(), id: z.string().max(100) }).safeParse(
      ((): unknown => { try { return JSON.parse(Buffer.from(query.cursor, "base64url").toString()); } catch { return null; } })(),
    );
    if (!decoded.success) throw new ApiError(400, "INVALID_CURSOR", "The audit cursor is invalid.");
    const at = new Date(decoded.data.at);
    filters.push(or(lt(schema.auditEvent.occurredAt, at), and(eq(schema.auditEvent.occurredAt, at), lt(schema.auditEvent.id, decoded.data.id))));
  }
  const rows = await database.select().from(schema.auditEvent).where(and(...filters))
    .orderBy(desc(schema.auditEvent.occurredAt), desc(schema.auditEvent.id)).limit(query.limit + 1);
  const events = rows.slice(0, query.limit);
  const last = events.at(-1);
  return { events, nextCursor: rows.length > query.limit && last
    ? Buffer.from(JSON.stringify({ at: last.occurredAt.toISOString(), id: last.id })).toString("base64url") : null,
    retentionDays: 365 };
}
