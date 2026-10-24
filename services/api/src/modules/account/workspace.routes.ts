import { schema, type RelayKitDatabase } from "@relayrtc/database";
import {
  createProject, updateProject, deleteProject, getProjectDetails, getProjectDeletionImpact,
  createEnvironment, updateEnvironment, deleteEnvironment, canManageProjects,
  organizationDeletionImpact, requestOrganizationDeletion, readWorkspaceDeletion, transferOrganizationOwnership,
} from "@relayrtc/auth/projects";
import {
  organizationIdSchema, projectIdSchema, environmentIdSchema,
  createProjectInputSchema, updateProjectInputSchema, deleteProjectInputSchema,
  createEnvironmentInputSchema, updateEnvironmentInputSchema, deleteEnvironmentInputSchema,
  deleteOrganizationInputSchema, transferOrganizationOwnershipInputSchema,
} from "@relayrtc/validation";
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";

interface Options {
  database: RelayKitDatabase;
  current: (request: FastifyRequest) => Promise<{ user: { id: string; email: string }; session: { id: string } }>;
}
const orgParams = z.object({ organizationId: organizationIdSchema });
const projectParams = z.object({ projectId: projectIdSchema });
const envParams = projectParams.extend({ environmentId: environmentIdSchema });
const root = "/api/account/workspaces";

function unwrap<T>(result: { data: T | null; error: { code: string; description: string } | null }): T {
  if (result.error) {
    const code = result.error.code;
    if (code === "PROJECT_ACCESS_DENIED") throw new ApiError(404, "PROJECT_NOT_FOUND", "This project is unavailable or you no longer have access.");
    const status = /FORBIDDEN|ACCESS_DENIED/.test(code) ? 403 : /NOT_FOUND/.test(code) ? 404 : /INVALID|CONFIRMATION/.test(code) ? 400 : /TAKEN|PROTECTED/.test(code) ? 409 : 500;
    throw new ApiError(status, code, result.error.description);
  }
  if (result.data === null) throw new ApiError(503, "WORKSPACE_UNAVAILABLE", "Workspace services are temporarily unavailable.");
  return result.data;
}

// Registered inside the account plugin: reuse its trusted Origin enforcement,
// session validation, request limits, audit handling and sanitized errors.
export function registerWorkspaceRoutes(app: FastifyInstance, { database, current }: Options) {
  const context = async (request: FastifyRequest) => ({ database, userId: (await current(request)).user.id });
  const memberOrganization = async (request: FastifyRequest, organizationId: string) => {
    const session = await current(request);
    const [row] = await database.select({ organization: schema.organization, role: schema.member.role, memberId: schema.member.id })
      .from(schema.organization).innerJoin(schema.member, eq(schema.member.organizationId, schema.organization.id))
      .where(and(eq(schema.organization.id, organizationId), eq(schema.member.userId, session.user.id)));
    if (!row) throw new ApiError(404, "ORGANIZATION_NOT_FOUND", "This organization is unavailable or you no longer have access.");
    return { ...row.organization, role: row.role, memberId: row.memberId, canManage: canManageProjects(row.role), isOwner: row.role.split(",").some(role => role.trim() === "owner") };
  };
  const incomingInvitations = (email: string, id?: string) => database.select({
    id: schema.invitation.id, organizationId: schema.invitation.organizationId,
    organizationName: schema.organization.name, email: schema.invitation.email, role: schema.invitation.role,
    expiresAt: schema.invitation.expiresAt, inviterEmail: schema.user.email, inviterName: schema.user.name,
  }).from(schema.invitation).innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
    .innerJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId)).where(and(
      sql`lower(${schema.invitation.email}) = ${email.toLowerCase()}`, eq(schema.invitation.status, "pending"),
      gt(schema.invitation.expiresAt, new Date()), eq(schema.organization.status, "active"), id ? eq(schema.invitation.id, id) : undefined,
    )).orderBy(desc(schema.invitation.createdAt));

  app.get(root, async request => {
    const session = await current(request);
    const rows = await database.select({ organization: schema.organization, role: schema.member.role, memberId: schema.member.id })
      .from(schema.member).innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .where(eq(schema.member.userId, session.user.id)).orderBy(asc(schema.organization.createdAt));
    const organizations = rows.map(row => ({ ...row.organization, role: row.role, memberId: row.memberId,
      canManage: canManageProjects(row.role), isOwner: row.role.split(",").some(role => role.trim() === "owner") }));
    const ids = organizations.map(row => row.id);
    const [projects, invitations, sessions] = await Promise.all([
      ids.length ? database.select().from(schema.project).where(and(inArray(schema.project.organizationId, ids), ne(schema.project.status, "deleted"))).orderBy(desc(schema.project.createdAt)) : Promise.resolve([]),
      incomingInvitations(session.user.email),
      database.select({ activeOrganizationId: schema.session.activeOrganizationId }).from(schema.session).where(eq(schema.session.id, session.session.id)),
    ]);
    return { userId: session.user.id, organizations, projects, invitations, activeOrganizationId: sessions[0]?.activeOrganizationId ?? null };
  });

  app.get(`${root}/organizations/:organizationId`, async request => {
    const { organizationId } = validate(orgParams, request.params);
    const organization = await memberOrganization(request, organizationId);
    const [members, invitations] = await Promise.all([
      database.select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role,
        createdAt: schema.member.createdAt, name: schema.user.name, email: schema.user.email, image: schema.user.image })
        .from(schema.member).innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, organizationId)).orderBy(asc(schema.member.createdAt)),
      organization.canManage ? database.select({ id: schema.invitation.id, email: schema.invitation.email, role: schema.invitation.role, expiresAt: schema.invitation.expiresAt })
        .from(schema.invitation).where(and(eq(schema.invitation.organizationId, organizationId), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date()))) : Promise.resolve([]),
    ]);
    return { organization, members, invitations };
  });
  app.get(`${root}/organizations/:organizationId/deletion-impact`, async request => {
    const { organizationId } = validate(orgParams, request.params);
    return unwrap(await organizationDeletionImpact(await context(request), organizationId));
  });
  app.post(`${root}/organizations/:organizationId/delete`, async request => {
    const params = validate(orgParams, request.params);
    const body = validate(z.object({ confirmationName: z.string().trim().min(1).max(120) }).strict(), request.body);
    return unwrap(await requestOrganizationDeletion(await context(request), validate(deleteOrganizationInputSchema, { ...body, ...params })));
  });
  app.post(`${root}/organizations/:organizationId/transfer`, async request => {
    const params = validate(orgParams, request.params);
    const body = validate(z.object({ targetMemberId: z.string().min(1).max(128) }).strict(), request.body);
    const input = validate(transferOrganizationOwnershipInputSchema, { ...body, ...params });
    const session = await current(request);
    return unwrap(await transferOrganizationOwnership({ database, currentUserId: session.user.id, ...input }));
  });

  app.post(`${root}/projects`, async request => unwrap(await createProject(await context(request), validate(createProjectInputSchema, request.body))));
  app.get(`${root}/projects/:projectId`, async request => {
    const { projectId } = validate(projectParams, request.params);
    return unwrap(await getProjectDetails(await context(request), projectId));
  });
  app.post(`${root}/projects/:projectId/update`, async request => {
    const params = validate(projectParams, request.params);
    const body = validate(z.object({ name: z.string().trim().min(1).max(120) }).strict(), request.body);
    return unwrap(await updateProject(await context(request), validate(updateProjectInputSchema, { ...body, ...params })));
  });
  app.get(`${root}/projects/:projectId/deletion-impact`, async request => {
    const { projectId } = validate(projectParams, request.params);
    return unwrap(await getProjectDeletionImpact(await context(request), projectId));
  });
  app.post(`${root}/projects/:projectId/delete`, async request => {
    const params = validate(projectParams, request.params);
    const body = validate(z.object({ confirmationName: z.string().trim().min(1).max(120) }).strict(), request.body);
    return unwrap(await deleteProject(await context(request), validate(deleteProjectInputSchema, { ...body, ...params })));
  });
  app.post(`${root}/projects/:projectId/environments`, async request => {
    const params = validate(projectParams, request.params);
    const body = validate(createEnvironmentInputSchema.omit({ projectId: true }), request.body);
    return unwrap(await createEnvironment(await context(request), validate(createEnvironmentInputSchema, { ...body, ...params })));
  });
  app.post(`${root}/projects/:projectId/environments/:environmentId/update`, async request => {
    const params = validate(envParams, request.params);
    const body = validate(updateEnvironmentInputSchema.omit({ projectId: true, environmentId: true }), request.body);
    return unwrap(await updateEnvironment(await context(request), validate(updateEnvironmentInputSchema, { ...body, ...params })));
  });
  app.post(`${root}/projects/:projectId/environments/:environmentId/delete`, async request => {
    const params = validate(envParams, request.params);
    validate(z.object({}).strict(), request.body);
    return unwrap(await deleteEnvironment(await context(request), validate(deleteEnvironmentInputSchema, params)));
  });
  app.get(`${root}/invitations/:invitationId`, async request => {
    const { invitationId } = validate(z.object({ invitationId: z.string().min(1).max(128) }), request.params);
    const session = await current(request);
    const [invitation] = await incomingInvitations(session.user.email, invitationId);
    if (!invitation) throw new ApiError(404, "INVITATION_UNAVAILABLE", "This invitation is expired, unavailable, or addressed to a different account.");
    return invitation;
  });
  app.get(`${root}/deletions`, async request => {
    const query = validate(z.object({ kind: z.enum(["organization", "project", "environment"]), resourceId: z.string().min(1).max(128) }).strict(), request.query);
    const result = await readWorkspaceDeletion(await context(request), query.kind, query.resourceId);
    if (result.forbidden) throw new ApiError(403, "DELETION_ACCESS_DENIED", "You do not have access to this deletion.");
    return { operation: result.data };
  });
}
