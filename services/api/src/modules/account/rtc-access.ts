import { setUserAuditContext } from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../http/errors/api-error.js";

export type RtcTransaction = Parameters<Parameters<RelayKitDatabase["transaction"]>[0]>[0];
export const canOperateRtc = (role: string) => role.split(",").some(value => ["owner", "admin", "developer"].includes(value.trim()));
const unavailable = () => new ApiError(404, "RTC_SCOPE_NOT_FOUND", "This project or environment is unavailable or you no longer have access.");

// Parent and membership locks keep authorization valid until the transaction
// commits, including concurrent role changes and workspace deletion.
export async function authorizeRtcProject(transaction: RtcTransaction, userId: string, projectId: string, writing = false) {
  await setUserAuditContext(transaction, userId);
  const [reference] = await transaction.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, projectId));
  if (!reference) throw unavailable();
  const [organization] = await transaction.select({ id: schema.organization.id }).from(schema.organization)
    .where(and(eq(schema.organization.id, reference.organizationId), eq(schema.organization.status, "active"))).for("share");
  if (!organization) throw unavailable();
  const [project] = await transaction.select().from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, organization.id), eq(schema.project.status, "active"))).for("share");
  if (!project) throw unavailable();
  const [membership] = await transaction.select({ role: schema.member.role }).from(schema.member)
    .where(and(eq(schema.member.organizationId, organization.id), eq(schema.member.userId, userId))).for("share");
  if (!membership) throw unavailable();
  const canOperate = canOperateRtc(membership.role);
  if (writing && !canOperate) throw new ApiError(403, "RTC_OPERATION_FORBIDDEN", "Only organization owners, admins, and developers can manage rooms and participants.");
  return { project, role: membership.role, canOperate };
}

export async function authorizeRtcEnvironment(transaction: RtcTransaction, projectId: string, environmentId: string) {
  const [environment] = await transaction.select().from(schema.environment)
    .where(and(eq(schema.environment.id, environmentId), eq(schema.environment.projectId, projectId), eq(schema.environment.status, "active"))).for("share");
  if (!environment) throw unavailable();
  return environment;
}
