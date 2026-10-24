import type { RelayKitDatabase } from "@relayrtc/database"
import { schema } from "@relayrtc/database"
import { setUserAuditContext } from "./audit.js"
import type {
  ApiKeyScope,
  CreateApiKeyInput,
  RevokeApiKeyInput,
  RotateApiKeyInput,
} from "@relayrtc/validation"
import { and, desc, eq } from "drizzle-orm"

import {
  apiKeyHashMatches,
  apiKeyPrefixFromRaw,
  generateApiKey,
} from "./api-key-credentials.js"
import {
  apiKeyError,
  type ApiKeyErrorCode,
  type ApiKeyResult,
} from "./api-key-errors.js"

interface ApiKeyServiceContext {
  database: RelayKitDatabase
  userId: string
}

interface ApiKeyAuthenticationContext {
  database: RelayKitDatabase
}

type RelayKitTransaction = Parameters<
  Parameters<RelayKitDatabase["transaction"]>[0]
>[0]

type StoredApiKeyRecord = typeof schema.apiKey.$inferSelect

export type ApiKeyRecord = Omit<StoredApiKeyRecord, "hashedSecret">

export interface RevealedApiKey {
  apiKey: ApiKeyRecord
  rawKey: string
}

export interface AuthenticateApiKeyInput {
  environmentId: string
  projectId: string
  rawKey: string
  requiredScope?: ApiKeyScope
}

const managementRoles = new Set(["owner", "admin"])

const canManageApiKeys = (role: string): boolean =>
  role.split(",").some((value) => managementRoles.has(value.trim()))

const failure = <T>(code: ApiKeyErrorCode): ApiKeyResult<T> => ({
  data: null,
  error: apiKeyError(code),
})

const success = <T>(data: T): ApiKeyResult<T> => ({ data, error: null })

const publicApiKeyColumns = {
  id: schema.apiKey.id,
  projectId: schema.apiKey.projectId,
  environmentId: schema.apiKey.environmentId,
  name: schema.apiKey.name,
  type: schema.apiKey.type,
  prefix: schema.apiKey.prefix,
  scopes: schema.apiKey.scopes,
  createdAt: schema.apiKey.createdAt,
  lastUsedAt: schema.apiKey.lastUsedAt,
  expiresAt: schema.apiKey.expiresAt,
  revokedAt: schema.apiKey.revokedAt,
  createdBy: schema.apiKey.createdBy,
}

const withoutSecret = ({ hashedSecret, ...apiKey }: StoredApiKeyRecord) => {
  void hashedSecret
  return apiKey
}

const getLockedProjectAccess = async (
  transaction: RelayKitTransaction,
  projectId: string,
  userId: string
) => {
  await setUserAuditContext(transaction, userId)
  const [reference] = await transaction
    .select({ organizationId: schema.project.organizationId })
    .from(schema.project).where(eq(schema.project.id, projectId))
  if (!reference) return null
  const [organization] = await transaction.select({ id: schema.organization.id })
    .from(schema.organization)
    .where(and(eq(schema.organization.id, reference.organizationId), eq(schema.organization.status, "active")))
    .for("share")
  if (!organization) return null
  const [project] = await transaction
    .select({ id: schema.project.id, organizationId: schema.project.organizationId })
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, organization.id), eq(schema.project.status, "active")))
    .for("update")

  if (!project) return null

  const [membership] = await transaction
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, project.organizationId),
        eq(schema.member.userId, userId)
      )
    )
    .for("share")

  return membership ? { project, role: membership.role } : null
}

const getProjectEnvironment = async (
  transaction: RelayKitTransaction,
  projectId: string,
  environmentId: string
) => {
  const [environment] = await transaction
    .select({ id: schema.environment.id, type: schema.environment.type })
    .from(schema.environment)
    .where(
      and(
        eq(schema.environment.id, environmentId),
        eq(schema.environment.projectId, projectId),
        eq(schema.environment.status, "active")
      )
    )
    .for("share")

  return environment
}

const replacementExpiration = (
  apiKey: Pick<StoredApiKeyRecord, "createdAt" | "expiresAt">,
  now: Date
): Date | null => {
  if (!apiKey.expiresAt) return null
  const lifetime = apiKey.expiresAt.getTime() - apiKey.createdAt.getTime()
  return new Date(now.getTime() + lifetime)
}

export const listProjectApiKeys = async (
  { database, userId }: ApiKeyServiceContext,
  projectId: string
): Promise<ApiKeyResult<ApiKeyRecord[]>> =>
  database.transaction(async (transaction) => {
    const access = await getLockedProjectAccess(transaction, projectId, userId)
    if (!access) return failure("API_KEY_ACCESS_DENIED")

    const apiKeys = await transaction
      .select(publicApiKeyColumns)
      .from(schema.apiKey)
      .where(eq(schema.apiKey.projectId, projectId))
      .orderBy(desc(schema.apiKey.createdAt))

    return success(apiKeys)
  })

export const createApiKey = async (
  { database, userId }: ApiKeyServiceContext,
  input: CreateApiKeyInput
): Promise<ApiKeyResult<RevealedApiKey>> => {
  try {
    return await database.transaction(async (transaction) => {
      const access = await getLockedProjectAccess(transaction, input.projectId, userId)
      if (!access || !canManageApiKeys(access.role)) {
        return failure("API_KEY_MANAGEMENT_FORBIDDEN")
      }

      const environment = await getProjectEnvironment(
        transaction,
        input.projectId,
        input.environmentId
      )
      if (!environment) return failure("API_KEY_ENVIRONMENT_MISMATCH")

      const now = new Date()
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
      if (expiresAt && expiresAt <= now) {
        return failure("API_KEY_EXPIRATION_INVALID")
      }

      const credentials = generateApiKey(input.type, environment.type)
      const [created] = await transaction
        .insert(schema.apiKey)
        .values({
          id: `key_${crypto.randomUUID()}`,
          projectId: input.projectId,
          environmentId: input.environmentId,
          name: input.name,
          type: input.type,
          prefix: credentials.prefix,
          hashedSecret: credentials.hashedSecret,
          scopes: input.type === "publishable" ? [] : input.scopes,
          createdAt: now,
          expiresAt,
          createdBy: userId,
        })
        .returning()

      return created
        ? success({ apiKey: withoutSecret(created), rawKey: credentials.rawKey })
        : failure("API_KEY_CREATION_FAILED")
    })
  } catch {
    return failure("API_KEY_CREATION_FAILED")
  }
}

export const rotateApiKey = async (
  { database, userId }: ApiKeyServiceContext,
  input: RotateApiKeyInput
): Promise<ApiKeyResult<RevealedApiKey>> => {
  try {
    return await database.transaction(async (transaction) => {
      const access = await getLockedProjectAccess(transaction, input.projectId, userId)
      if (!access || !canManageApiKeys(access.role)) {
        return failure("API_KEY_MANAGEMENT_FORBIDDEN")
      }

      const [current] = await transaction
        .select()
        .from(schema.apiKey)
        .where(
          and(
            eq(schema.apiKey.id, input.apiKeyId),
            eq(schema.apiKey.projectId, input.projectId)
          )
        )
        .for("update")

      if (!current) return failure("API_KEY_NOT_FOUND")
      if (current.revokedAt) return failure("API_KEY_REVOKED")

      const environment = await getProjectEnvironment(
        transaction,
        current.projectId,
        current.environmentId
      )
      if (!environment) return failure("API_KEY_ENVIRONMENT_MISMATCH")

      const now = new Date()
      const credentials = generateApiKey(
        current.type === "publishable" ? "publishable" : "secret",
        environment.type
      )

      await transaction
        .update(schema.apiKey)
        .set({ revokedAt: now })
        .where(eq(schema.apiKey.id, current.id))

      const [replacement] = await transaction
        .insert(schema.apiKey)
        .values({
          id: `key_${crypto.randomUUID()}`,
          projectId: current.projectId,
          environmentId: current.environmentId,
          name: current.name,
          type: current.type,
          prefix: credentials.prefix,
          hashedSecret: credentials.hashedSecret,
          scopes: current.scopes,
          createdAt: now,
          expiresAt: replacementExpiration(current, now),
          createdBy: userId,
        })
        .returning()

      return replacement
        ? success({ apiKey: withoutSecret(replacement), rawKey: credentials.rawKey })
        : failure("API_KEY_ROTATION_FAILED")
    })
  } catch {
    return failure("API_KEY_ROTATION_FAILED")
  }
}

export const revokeApiKey = async (
  { database, userId }: ApiKeyServiceContext,
  input: RevokeApiKeyInput
): Promise<ApiKeyResult<ApiKeyRecord>> => {
  try {
    return await database.transaction(async (transaction) => {
      const access = await getLockedProjectAccess(transaction, input.projectId, userId)
      if (!access || !canManageApiKeys(access.role)) {
        return failure("API_KEY_MANAGEMENT_FORBIDDEN")
      }

      const [current] = await transaction
        .select()
        .from(schema.apiKey)
        .where(
          and(
            eq(schema.apiKey.id, input.apiKeyId),
            eq(schema.apiKey.projectId, input.projectId)
          )
        )
        .for("update")

      if (!current) return failure("API_KEY_NOT_FOUND")
      if (current.revokedAt) return failure("API_KEY_REVOKED")

      const [revoked] = await transaction
        .update(schema.apiKey)
        .set({ revokedAt: new Date() })
        .where(eq(schema.apiKey.id, current.id))
        .returning()

      return revoked
        ? success(withoutSecret(revoked))
        : failure("API_KEY_REVOCATION_FAILED")
    })
  } catch {
    return failure("API_KEY_REVOCATION_FAILED")
  }
}

export const authenticateApiKey = async (
  { database }: ApiKeyAuthenticationContext,
  input: AuthenticateApiKeyInput
): Promise<ApiKeyRecord | null> => {
  const prefix = apiKeyPrefixFromRaw(input.rawKey)
  if (!prefix) return null

  return database.transaction(async (transaction) => {
    const [apiKey] = await transaction
      .select()
      .from(schema.apiKey)
      .where(eq(schema.apiKey.prefix, prefix))
      .for("update")

    const now = new Date()
    if (
      !apiKey ||
      !apiKeyHashMatches(input.rawKey, apiKey.hashedSecret) ||
      apiKey.projectId !== input.projectId ||
      apiKey.environmentId !== input.environmentId ||
      apiKey.revokedAt !== null ||
      (apiKey.expiresAt !== null && apiKey.expiresAt <= now) ||
      (input.requiredScope !== undefined && !apiKey.scopes.includes(input.requiredScope))
    ) {
      return null
    }

    const [project] = await transaction
      .select({ status: schema.project.status })
      .from(schema.project)
      .where(eq(schema.project.id, apiKey.projectId))
    if (project?.status !== "active") return null

    const [used] = await transaction
      .update(schema.apiKey)
      .set({ lastUsedAt: now })
      .where(eq(schema.apiKey.id, apiKey.id))
      .returning()

    return used ? withoutSecret(used) : null
  })
}

export * from "./api-key-errors.js"

