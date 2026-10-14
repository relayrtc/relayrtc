import { apiKeyScopes, apiKeyTypes, type ApiKey, type StoredApiKey } from "@relayrtc/types";
import { z } from "zod";

import {
  apiKeyIdSchema,
  environmentIdSchema,
  isoDateTimeSchema,
  nameSchema,
  projectIdSchema,
  userIdSchema,
} from "./common.js";

export const apiKeyTypeSchema = z.enum(apiKeyTypes);
export const apiKeyScopeSchema = z.enum(apiKeyScopes);
export const availableApiKeyScopes = apiKeyScopes;
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

const uniqueApiKeyScopesSchema = z
  .array(apiKeyScopeSchema)
  .max(apiKeyScopes.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "API key scopes must be unique",
  });

export const createApiKeyInputSchema = z
  .object({
    projectId: projectIdSchema,
    environmentId: environmentIdSchema,
    name: nameSchema,
    type: apiKeyTypeSchema,
    scopes: uniqueApiKeyScopesSchema,
    expiresAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .refine(hasValidApiKeyAccess, {
    message: "Publishable API keys cannot have privileged scopes",
    path: ["scopes"],
  });

export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

export const rotateApiKeyInputSchema = z
  .object({
    apiKeyId: apiKeyIdSchema,
    projectId: projectIdSchema,
  })
  .strict();

export type RotateApiKeyInput = z.infer<typeof rotateApiKeyInputSchema>;

export const revokeApiKeyInputSchema = z
  .object({
    apiKeyId: apiKeyIdSchema,
    projectId: projectIdSchema,
  })
  .strict();

export type RevokeApiKeyInput = z.infer<typeof revokeApiKeyInputSchema>;

const apiKeyShape = {
  id: apiKeyIdSchema,
  projectId: projectIdSchema,
  environmentId: environmentIdSchema,
  name: nameSchema,
  type: apiKeyTypeSchema,
  prefix: z.string().min(8).max(32),
  scopes: uniqueApiKeyScopesSchema,
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdBy: userIdSchema.nullable(),
};

function hasValidApiKeyAccess(value: {
  readonly type: "publishable" | "secret";
  readonly scopes: readonly string[];
}) {
  return value.type === "secret" || value.scopes.length === 0;
}

function hasValidApiKeyExpiration(value: {
  readonly createdAt: string;
  readonly expiresAt: string | null;
}) {
  return value.expiresAt === null || Date.parse(value.expiresAt) > Date.parse(value.createdAt);
}

export const apiKeySchema: z.ZodType<ApiKey> = z
  .object(apiKeyShape)
  .strict()
  .refine(hasValidApiKeyAccess, {
    message: "Publishable API keys cannot have privileged scopes",
    path: ["scopes"],
  })
  .refine(hasValidApiKeyExpiration, {
    message: "expiresAt must follow createdAt",
    path: ["expiresAt"],
  });

export const storedApiKeySchema: z.ZodType<StoredApiKey> = z
  .object({
    ...apiKeyShape,
    hashedSecret: z.string().min(32).max(512),
  })
  .strict()
  .refine(hasValidApiKeyAccess, {
    message: "Publishable API keys cannot have privileged scopes",
    path: ["scopes"],
  })
  .refine(hasValidApiKeyExpiration, {
    message: "expiresAt must follow createdAt",
    path: ["expiresAt"],
  });
