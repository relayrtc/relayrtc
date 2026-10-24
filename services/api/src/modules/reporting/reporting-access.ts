import type { RelayKitDatabase } from "@relayrtc/database";
import { schema } from "@relayrtc/database";
import { and, eq } from "drizzle-orm";

import type { ApiKeyPrincipal } from "../../authentication/api-key-authenticator.js";
import { ApiError } from "../../http/errors/api-error.js";

export type ReportingPrincipal =
  { type: "session"; userId: string } | { type: "apiKey"; key: ApiKeyPrincipal };

export interface ReportingAccessRepository {
  project: (projectId: string) => Promise<{ organizationId: string; status: string } | null>;
  isMember: (organizationId: string, userId: string) => Promise<boolean>;
  environmentBelongsToProject: (environmentId: string, projectId: string) => Promise<boolean>;
}

export const createReportingAccessRepository = (
  database: RelayKitDatabase,
): ReportingAccessRepository => ({
  async project(projectId) {
    const [project] = await database
      .select({
        organizationId: schema.project.organizationId,
        status: schema.project.status,
      })
      .from(schema.project)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.project.organizationId))
      .where(and(eq(schema.project.id, projectId), eq(schema.organization.status, "active")))
      .limit(1);
    return project ?? null;
  },
  async isMember(organizationId, userId) {
    const [member] = await database
      .select({ id: schema.member.id })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .where(
        and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId), eq(schema.organization.status, "active")),
      )
      .limit(1);
    return member !== undefined;
  },
  async environmentBelongsToProject(environmentId, projectId) {
    const [environment] = await database
      .select({ id: schema.environment.id })
      .from(schema.environment)
      .where(
        and(eq(schema.environment.id, environmentId), eq(schema.environment.projectId, projectId), eq(schema.environment.status, "active")),
      )
      .limit(1);
    return environment !== undefined;
  },
});

export const authorizeOrganizationReport = async (
  repository: ReportingAccessRepository,
  principal: ReportingPrincipal,
  organizationId: string,
): Promise<void> => {
  if (principal.type !== "session") {
    throw new ApiError(
      403,
      "ORGANIZATION_SESSION_REQUIRED",
      "Organization reports require a console session",
    );
  }
  if (!(await repository.isMember(organizationId, principal.userId))) {
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found");
  }
};

export const authorizeProjectReport = async (
  repository: ReportingAccessRepository,
  principal: ReportingPrincipal,
  projectId: string,
  requestedEnvironmentId: string | undefined,
  scope: "usage:read" | "analytics:read",
): Promise<{ organizationId: string; projectId: string; environmentId: string | null }> => {
  let environmentId = requestedEnvironmentId ?? null;
  if (principal.type === "apiKey") {
    if (principal.key.keyType !== "secret" || !principal.key.scopes.includes(scope)) {
      throw new ApiError(403, "API_KEY_SCOPE_REQUIRED", `The API key requires the ${scope} scope`);
    }
    if (principal.key.projectId !== projectId) {
      throw new ApiError(
        403,
        "PROJECT_SCOPE_MISMATCH",
        "The API key does not belong to the requested project",
      );
    }
    if (environmentId !== null && environmentId !== principal.key.environmentId) {
      throw new ApiError(
        403,
        "ENVIRONMENT_SCOPE_MISMATCH",
        "The API key does not belong to the requested environment",
      );
    }
    environmentId = principal.key.environmentId;
  }
  const project = await repository.project(projectId);
  if (project?.status !== "active") {
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found");
  }
  if (principal.type === "session") {
    await authorizeOrganizationReport(repository, principal, project.organizationId);
  }
  if (
    environmentId !== null &&
    !(await repository.environmentBelongsToProject(environmentId, projectId))
  ) {
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found");
  }
  return { organizationId: project.organizationId, projectId, environmentId };
};
