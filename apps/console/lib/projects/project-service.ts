import type { RelayKitDatabase } from "@relayrtc/database"
import { schema } from "@relayrtc/database"
import type {
  CreateEnvironmentInput,
  CreateProjectInput,
  DeleteEnvironmentInput,
  DeleteProjectInput,
  UpdateEnvironmentInput,
  UpdateProjectInput,
} from "@relayrtc/validation"
import { generateResourceSlug, setUserAuditContext } from "@relayrtc/auth"
import {
  getResourceDeletionImpact,
  getRuntimeOperation,
  type RuntimeOperationView,
  type ResourceDeletionImpact,
} from "@relayrtc/auth"
import { and, asc, desc, eq, sql } from "drizzle-orm"

import {
  projectError,
  type ProjectErrorCode,
  type ProjectResult,
} from "./project-errors"

export type ProjectRecord = typeof schema.project.$inferSelect
export type EnvironmentRecord = typeof schema.environment.$inferSelect

export interface ProjectDetails {
  canManage: boolean
  environments: EnvironmentRecord[]
  project: ProjectRecord
}

interface ProjectServiceContext {
  database: RelayKitDatabase
  userId: string
}

type RelayKitTransaction = Parameters<
  Parameters<RelayKitDatabase["transaction"]>[0]
>[0]

const managementRoles = new Set(["owner", "admin"])

export const canManageProjects = (role: string): boolean =>
  role.split(",").some((value) => managementRoles.has(value.trim()))

const createEnvironmentId = (): string =>
  `env_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`

const failure = <T>(code: ProjectErrorCode): ProjectResult<T> => ({
  data: null,
  error: projectError(code),
})

const success = <T>(data: T): ProjectResult<T> => ({ data, error: null })

const readErrorProperty = (error: unknown, property: string): string | undefined => {
  if (typeof error !== "object" || error === null || !(property in error)) {
    return undefined
  }

  const value = (error as Record<string, unknown>)[property]
  return typeof value === "string" ? value : undefined
}

const isUniqueViolation = (error: unknown, constraint: string): boolean =>
  readErrorProperty(error, "code") === "23505" &&
  readErrorProperty(error, "constraint_name") === constraint

const getLockedMembership = async (
  transaction: RelayKitTransaction,
  organizationId: string,
  userId: string
) => {
  await setUserAuditContext(transaction, userId)
  const [organization] = await transaction.select({ status: schema.organization.status })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).for("share")
  if (organization?.status !== "active") return undefined
  const [membership] = await transaction
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, organizationId),
        eq(schema.member.userId, userId)
      )
    )
    .for("share")

  return membership
}

const getLockedProject = async (
  transaction: RelayKitTransaction,
  projectId: string
) => {
  const [parent] = await transaction.select({ organizationId: schema.project.organizationId })
    .from(schema.project).where(eq(schema.project.id, projectId))
  if (!parent) return undefined
  const [organization] = await transaction.select({ status: schema.organization.status })
    .from(schema.organization).where(eq(schema.organization.id, parent.organizationId)).for("share")
  if (organization?.status !== "active") return undefined
  const [project] = await transaction
    .select()
    .from(schema.project)
    .where(eq(schema.project.id, projectId))
    .for("update")

  return project
}

export const listOrganizationProjects = async (
  { database, userId }: ProjectServiceContext,
  organizationId: string
): Promise<ProjectResult<ProjectRecord[]>> => {
  return database.transaction(async (transaction) => {
    const membership = await getLockedMembership(
      transaction,
      organizationId,
      userId
    )

    if (!membership) return failure("PROJECT_ACCESS_DENIED")

    const projects = await transaction
      .select()
      .from(schema.project)
      .where(eq(schema.project.organizationId, organizationId))
      .orderBy(desc(schema.project.createdAt))

    return success(projects)
  })
}

export const getProjectDetails = async (
  { database, userId }: ProjectServiceContext,
  projectId: string
): Promise<ProjectResult<ProjectDetails>> => {
  return database.transaction(async (transaction) => {
    const project = await getLockedProject(transaction, projectId)

    if (!project) return failure("PROJECT_NOT_FOUND")

    const membership = await getLockedMembership(
      transaction,
      project.organizationId,
      userId
    )

    if (!membership) return failure("PROJECT_ACCESS_DENIED")

    const environments = await transaction
      .select()
      .from(schema.environment)
      .where(eq(schema.environment.projectId, project.id))
      .orderBy(asc(schema.environment.createdAt))

    return success({
      canManage: canManageProjects(membership.role),
      environments,
      project,
    })
  })
}

export const createProject = async (
  { database, userId }: ProjectServiceContext,
  input: CreateProjectInput
): Promise<ProjectResult<ProjectRecord>> => {
  try {
    return await database.transaction(async (transaction) => {
      const membership = await getLockedMembership(
        transaction,
        input.organizationId,
        userId
      )

      if (!membership || !canManageProjects(membership.role)) {
        return failure("PROJECT_MANAGEMENT_FORBIDDEN")
      }

      const now = new Date()
      const [project] = await transaction
        .insert(schema.project)
        .values({
          id: `project_${crypto.randomUUID()}`,
          name: input.name,
          organizationId: input.organizationId,
          slug: generateResourceSlug(input.name, "project"),
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning()

      if (!project) return failure("PROJECT_CREATION_FAILED")

      await transaction.insert(schema.environment).values([
        {
          id: createEnvironmentId(),
          name: "Development",
          projectId: project.id,
          slug: "development",
          type: "development",
          deletionProtected: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: createEnvironmentId(),
          name: "Production",
          projectId: project.id,
          slug: "production",
          type: "production",
          deletionProtected: true,
          createdAt: now,
          updatedAt: now,
        },
      ])

      return success(project)
    })
  } catch (error) {
    return failure(
      isUniqueViolation(error, "project_organization_slug_idx")
        ? "PROJECT_SLUG_TAKEN"
        : "PROJECT_CREATION_FAILED"
    )
  }
}

export const updateProject = async (
  { database, userId }: ProjectServiceContext,
  input: UpdateProjectInput
): Promise<ProjectResult<ProjectRecord>> => {
  try {
    return await database.transaction(async (transaction) => {
      const project = await getLockedProject(transaction, input.projectId)

      if (!project) return failure("PROJECT_NOT_FOUND")

      const membership = await getLockedMembership(
        transaction,
        project.organizationId,
        userId
      )

      if (!membership || !canManageProjects(membership.role)) {
        return failure("PROJECT_MANAGEMENT_FORBIDDEN")
      }

      const [updatedProject] = await transaction
        .update(schema.project)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(schema.project.id, project.id))
        .returning()

      return updatedProject
        ? success(updatedProject)
        : failure("PROJECT_UPDATE_FAILED")
    })
  } catch (error) {
    return failure(
      isUniqueViolation(error, "project_organization_slug_idx")
        ? "PROJECT_SLUG_TAKEN"
        : "PROJECT_UPDATE_FAILED"
    )
  }
}

export const deleteProject = async (
  { database, userId }: ProjectServiceContext,
  input: DeleteProjectInput
): Promise<ProjectResult<{ projectId: string; operation: RuntimeOperationView | null }>> => {
  try {
    const authorization = await database.transaction(async (transaction) => {
      const project = await getLockedProject(transaction, input.projectId)

      if (!project) return failure("PROJECT_NOT_FOUND")

      const membership = await getLockedMembership(
        transaction,
        project.organizationId,
        userId
      )

      if (!membership || !canManageProjects(membership.role)) {
        return failure("PROJECT_MANAGEMENT_FORBIDDEN")
      }

      if (input.confirmationName !== project.name) {
        return failure("PROJECT_CONFIRMATION_MISMATCH")
      }

      await transaction
        .update(schema.project)
        .set({ status: "deleting", updatedAt: new Date() })
        .where(eq(schema.project.id, project.id))
      await transaction.execute(sql`UPDATE runtime_operation SET payload = payload || jsonb_build_object('requestedBy', ${userId}::text)
        WHERE id = ${`project.delete:${project.id}`} AND NOT (payload ? 'requestedBy')`)
      return success({ projectId: project.id })
    })
    if (authorization.error) return failure(authorization.error.code)

    return success({ projectId: input.projectId, operation: await getRuntimeOperation(database, `project.delete:${input.projectId}`) })
  } catch {
    return failure("PROJECT_DELETION_FAILED")
  }
}

export const getProjectDeletionImpact = async (
  context: ProjectServiceContext,
  projectId: string,
): Promise<ProjectResult<ResourceDeletionImpact>> => {
  const details = await getProjectDetails(context, projectId)
  if (details.error) return failure(details.error.code)
  if (!details.data.canManage) return failure("PROJECT_MANAGEMENT_FORBIDDEN")
  return success(await getResourceDeletionImpact(context.database, { projectId }))
}

export const updateEnvironment = async (
  { database, userId }: ProjectServiceContext,
  input: UpdateEnvironmentInput
): Promise<ProjectResult<EnvironmentRecord>> => {
  try {
    return await database.transaction(async (transaction) => {
      const project = await getLockedProject(transaction, input.projectId)

      if (!project) return failure("PROJECT_NOT_FOUND")

      const membership = await getLockedMembership(
        transaction,
        project.organizationId,
        userId
      )

      if (!membership || !canManageProjects(membership.role)) {
        return failure("PROJECT_MANAGEMENT_FORBIDDEN")
      }

      const [currentEnvironment] = await transaction
        .select({ type: schema.environment.type, status: schema.environment.status })
        .from(schema.environment)
        .where(
          and(
            eq(schema.environment.id, input.environmentId),
            eq(schema.environment.projectId, project.id)
          )
        )
        .for("update")

      if (currentEnvironment?.status !== "active") return failure("ENVIRONMENT_NOT_FOUND")

      const [environment] = await transaction
        .update(schema.environment)
        .set({
          deletionProtected:
            currentEnvironment.type === "development" ||
            currentEnvironment.type === "production"
              ? true
              : input.deletionProtected,
          name: input.name,
          slug: input.slug,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.environment.id, input.environmentId),
            eq(schema.environment.projectId, project.id)
          )
        )
        .returning()

      return environment
        ? success(environment)
        : failure("ENVIRONMENT_NOT_FOUND")
    })
  } catch (error) {
    return failure(
      isUniqueViolation(error, "environment_project_slug_idx")
        ? "ENVIRONMENT_SLUG_TAKEN"
        : "ENVIRONMENT_UPDATE_FAILED"
    )
  }
}

export const createEnvironment = async (
  { database, userId }: ProjectServiceContext,
  input: CreateEnvironmentInput
): Promise<ProjectResult<EnvironmentRecord>> => {
  try {
    return await database.transaction(async (transaction) => {
      const project = await getLockedProject(transaction, input.projectId)

      if (!project) return failure("PROJECT_NOT_FOUND")

      const membership = await getLockedMembership(
        transaction,
        project.organizationId,
        userId
      )

      if (!membership || !canManageProjects(membership.role)) {
        return failure("PROJECT_MANAGEMENT_FORBIDDEN")
      }

      const now = new Date()
      const [environment] = await transaction
        .insert(schema.environment)
        .values({
          id: createEnvironmentId(),
          deletionProtected: input.deletionProtected,
          name: input.name,
          projectId: project.id,
          slug: input.slug,
          type: input.type,
          createdAt: now,
          updatedAt: now,
        })
        .returning()

      return environment
        ? success(environment)
        : failure("ENVIRONMENT_CREATION_FAILED")
    })
  } catch (error) {
    return failure(
      isUniqueViolation(error, "environment_project_slug_idx")
        ? "ENVIRONMENT_SLUG_TAKEN"
        : "ENVIRONMENT_CREATION_FAILED"
    )
  }
}

export const deleteEnvironment = async (
  { database, userId }: ProjectServiceContext,
  input: DeleteEnvironmentInput
): Promise<ProjectResult<{ environmentId: string; projectId: string; operation: RuntimeOperationView | null }>> => {
  try {
    const authorization = await database.transaction(async (transaction) => {
      const project = await getLockedProject(transaction, input.projectId)

      if (!project) return failure("PROJECT_NOT_FOUND")

      const membership = await getLockedMembership(
        transaction,
        project.organizationId,
        userId
      )

      if (!membership || !canManageProjects(membership.role)) {
        return failure("PROJECT_MANAGEMENT_FORBIDDEN")
      }

      const [environment] = await transaction
        .select({
          deletionProtected: schema.environment.deletionProtected,
          id: schema.environment.id,
          type: schema.environment.type,
        })
        .from(schema.environment)
        .where(
          and(
            eq(schema.environment.id, input.environmentId),
            eq(schema.environment.projectId, project.id)
          )
        )
        .for("update")

      if (!environment) return failure("ENVIRONMENT_NOT_FOUND")
      if (
        environment.deletionProtected ||
        environment.type === "development" ||
        environment.type === "production"
      ) {
        return failure("ENVIRONMENT_PROTECTED")
      }

      await transaction.update(schema.environment)
        .set({ status: "deleting", updatedAt: new Date() })
        .where(eq(schema.environment.id, environment.id))
      const operationId = `environment.delete:${environment.id}`
      await transaction.execute(sql`UPDATE runtime_operation SET payload = payload || jsonb_build_object('requestedBy', ${userId}::text)
        WHERE id = ${operationId} AND NOT (payload ? 'requestedBy')`)
      return success({ environmentId: environment.id, projectId: project.id })
    })
    if (authorization.error) return failure(authorization.error.code)
    return success({ environmentId: input.environmentId, projectId: input.projectId, operation: await getRuntimeOperation(database, `environment.delete:${input.environmentId}`) })
  } catch {
    return failure("ENVIRONMENT_DELETION_FAILED")
  }
}

