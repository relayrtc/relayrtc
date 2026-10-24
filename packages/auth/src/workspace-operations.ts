import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { and, eq, sql } from "drizzle-orm";
import { authError } from "./errors.js";
import { setUserAuditContext } from "./audit.js";
import { getResourceDeletionImpact } from "./resource-deletion.js";
import { getRuntimeOperation } from "./runtime-operations.js";

const owner = (role: string) => role.split(",").some(value => value.trim() === "owner");
type Context = { database: RelayKitDatabase; userId: string };

async function ownedOrganization({ database, userId }: Context, organizationId: string) {
  const [row] = await database.select({ id: schema.organization.id, name: schema.organization.name, role: schema.member.role })
    .from(schema.organization).innerJoin(schema.member, eq(schema.member.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.id, organizationId), eq(schema.member.userId, userId)));
  return row && owner(row.role) ? row : null;
}

export async function organizationDeletionImpact(context: Context, organizationId: string) {
  if (!await ownedOrganization(context, organizationId)) return { data: null, error: authError("ORGANIZATION_DELETION_FORBIDDEN") };
  return { data: await getResourceDeletionImpact(context.database, { organizationId }), error: null };
}

// Preserve the console's lifecycle: mark deleting and let the existing runtime
// worker end RTC resources before database cleanup. Never delete rows directly.
export async function requestOrganizationDeletion(context: Context, input: { organizationId: string; confirmationName: string }) {
  const owned = await ownedOrganization(context, input.organizationId);
  if (!owned) return { data: null, error: authError("ORGANIZATION_DELETION_FORBIDDEN") };
  if (input.confirmationName !== owned.name) return { data: null, error: authError("ORGANIZATION_CONFIRMATION_MISMATCH") };
  try {
    await context.database.transaction(async transaction => {
      await setUserAuditContext(transaction, context.userId);
      const [organization] = await transaction.select({ name: schema.organization.name }).from(schema.organization)
        .where(eq(schema.organization.id, input.organizationId)).for("update");
      const [membership] = await transaction.select({ role: schema.member.role }).from(schema.member)
        .where(and(eq(schema.member.organizationId, input.organizationId), eq(schema.member.userId, context.userId))).for("update");
      if (organization?.name !== input.confirmationName || !membership || !owner(membership.role)) throw new Error("Organization changed");
      await transaction.update(schema.organization).set({ status: "deleting", updatedAt: new Date() }).where(eq(schema.organization.id, input.organizationId));
      await transaction.execute(sql`UPDATE runtime_operation SET payload = payload || jsonb_build_object('requestedBy', ${context.userId}::text)
        WHERE id = ${`organization.delete:${input.organizationId}`} AND NOT (payload ? 'requestedBy')`);
    });
    return { data: { organizationId: input.organizationId, operation: await getRuntimeOperation(context.database, `organization.delete:${input.organizationId}`) }, error: null };
  } catch { return { data: null, error: authError("ORGANIZATION_DELETION_FAILED") }; }
}

export async function readWorkspaceDeletion(context: Context, kind: "organization" | "project" | "environment", resourceId: string) {
  const id = `${kind}.delete:${resourceId}`;
  const [operation] = await context.database.select().from(schema.runtimeOperation).where(eq(schema.runtimeOperation.id, id));
  if (!operation) return { data: null, forbidden: false };
  const [membership] = operation.organizationId ? await context.database.select({ role: schema.member.role }).from(schema.member)
    .where(and(eq(schema.member.organizationId, operation.organizationId), eq(schema.member.userId, context.userId))) : [];
  const roles = membership?.role.split(",").map(value => value.trim()) ?? [];
  const observers = Array.isArray(operation.payload.observers) ? operation.payload.observers : [];
  const allowed = roles.includes("owner") || (kind !== "organization" && roles.includes("admin"))
    || (operation.status === "completed" && (operation.payload.requestedBy === context.userId || observers.includes(context.userId)));
  if (!allowed) return { data: null, forbidden: true };
  if (operation.status !== "completed") {
    await context.database.execute(sql`UPDATE runtime_operation SET payload = payload || jsonb_build_object('requestedBy', ${context.userId}::text)
      WHERE id = ${id} AND NOT (payload ? 'requestedBy')`);
    await context.database.execute(sql`UPDATE runtime_operation SET payload = jsonb_set(payload, '{observers}',
      coalesce(payload->'observers', '[]'::jsonb) || jsonb_build_array(${context.userId}::text)) WHERE id = ${id} AND status <> 'completed'
      AND NOT (coalesce(payload->'observers', '[]'::jsonb) @> jsonb_build_array(${context.userId}::text))`);
  }
  return { data: await getRuntimeOperation(context.database, id), forbidden: false };
}
