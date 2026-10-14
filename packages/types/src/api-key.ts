import type { ApiKeyId, EnvironmentId, IsoDateTime, ProjectId, UserId } from "./common.js";

export const apiKeyTypes = ["publishable", "secret"] as const;

export type ApiKeyType = (typeof apiKeyTypes)[number];

export const apiKeyScopes = [
  "rooms:create",
  "rooms:read",
  "rooms:end",
  "participants:read",
  "participants:remove",
  "tokens:create",
  "recordings:create",
  "recordings:read",
  "webhooks:read",
  "webhooks:write",
  "usage:read",
  "analytics:read",
] as const;

export type ApiKeyScope = (typeof apiKeyScopes)[number];

export interface ApiKey {
  readonly id: ApiKeyId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly type: ApiKeyType;
  readonly prefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: IsoDateTime;
  readonly lastUsedAt: IsoDateTime | null;
  readonly expiresAt: IsoDateTime | null;
  readonly revokedAt: IsoDateTime | null;
  readonly createdBy: UserId | null;
}

export interface StoredApiKey extends ApiKey {
  readonly hashedSecret: string;
}
