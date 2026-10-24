import { randomUUID } from "node:crypto";
import { setAuditContext, setUserAuditContext } from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import {
  createWebhookSecretVault,
  validateWebhookDestination,
  webhookSecretContext,
  type WebhookAddressResolver,
} from "@relayrtc/protocol/webhook-security";
import {
  webhookConfigurationSchema,
  type CreateWebhookInput,
  type UpdateWebhookInput,
} from "@relayrtc/validation";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { ApiKeyPrincipal } from "../../authentication/api-key-authenticator.js";
import { ApiError } from "../../http/errors/api-error.js";

export type WebhookPrincipal =
  { type: "apiKey"; key: ApiKeyPrincipal } | { type: "session"; userId: string };
export interface WebhookScope {
  projectId: string;
  environmentId: string;
}
type Transaction = Parameters<Parameters<RelayKitDatabase["transaction"]>[0]>[0];
type Endpoint = typeof schema.webhookEndpoint.$inferSelect;
const notFound = () =>
  new ApiError(404, "RESOURCE_NOT_FOUND", "The requested webhook or scope was not found");
const publicEndpoint = (endpoint: Endpoint) =>
  webhookConfigurationSchema.parse({
    id: endpoint.id,
    projectId: endpoint.projectId,
    environmentId: endpoint.environmentId,
    url: endpoint.url,
    eventTypes: endpoint.eventTypes,
    status: endpoint.status,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
    signingSecretVersion: endpoint.signingSecretVersion,
    signingSecretRotatedAt: endpoint.signingSecretRotatedAt.toISOString(),
  });
const endpointFilter = (scope: WebhookScope, id?: string) =>
  and(
    eq(schema.webhookEndpoint.projectId, scope.projectId),
    eq(schema.webhookEndpoint.environmentId, scope.environmentId),
    isNull(schema.webhookEndpoint.deletedAt),
    id === undefined ? undefined : eq(schema.webhookEndpoint.id, id),
  );

export async function authorizeWebhookScope(
  transaction: Transaction,
  principal: WebhookPrincipal,
  scope: WebhookScope,
  writing: boolean,
) {
  if (principal.type === "session") await setUserAuditContext(transaction, principal.userId);
  else {
    const [key] = await transaction.select({ name: schema.apiKey.name }).from(schema.apiKey).where(eq(schema.apiKey.id, principal.key.keyId));
    await setAuditContext(transaction, { type: "API_KEY", id: principal.key.keyId, name: key?.name ?? "API key" });
  }
  const requiredScope = writing ? "webhooks:write" : "webhooks:read";
  if (principal.type === "apiKey") {
    const key = principal.key;
    if (key.keyType !== "secret" || !key.scopes.includes(requiredScope))
      throw new ApiError(
        403,
        "API_KEY_SCOPE_REQUIRED",
        `The API key requires the ${requiredScope} scope`,
      );
    if (key.projectId !== scope.projectId)
      throw new ApiError(
        403,
        "PROJECT_SCOPE_MISMATCH",
        "The API key does not belong to the requested project",
      );
    if (key.environmentId !== scope.environmentId)
      throw new ApiError(
        403,
        "ENVIRONMENT_SCOPE_MISMATCH",
        "The API key does not belong to the requested environment",
      );
  }
  const [resource] = await transaction.execute(sql`
    select p.organization_id from project p join environment e on e.project_id = p.id
      join organization o on o.id = p.organization_id
    where p.id = ${scope.projectId} and e.id = ${scope.environmentId}
      and p.status = 'active' and e.status = 'active' and o.status = 'active'
    for share of p, e, o
  `);
  if (!resource) throw notFound();
  if (principal.type === "session") {
    const [membership] = await transaction.execute(sql`
      select role from member where organization_id = ${String(resource.organization_id)} and user_id = ${principal.userId} for share
    `);
    if (!membership) throw notFound();
    if (writing && !String(membership.role).split(",").some(role => ["owner", "admin"].includes(role.trim())))
      throw new ApiError(
        403,
        "WEBHOOK_MANAGEMENT_FORBIDDEN",
        "Only organization owners and admins can manage webhooks",
      );
  } else {
    const [key] = await transaction.execute(sql`
      select id from api_key where id = ${principal.key.keyId} and project_id = ${scope.projectId}
        and environment_id = ${scope.environmentId} and type = 'secret' and ${requiredScope} = any(scopes)
        and revoked_at is null and (expires_at is null or expires_at > now()) for share
    `);
    if (!key)
      throw new ApiError(401, "INVALID_API_KEY", "The API key is invalid, expired, or revoked");
  }
}

export function createWebhookService(options: {
  database: RelayKitDatabase;
  encryptionKey?: string;
  resolve?: WebhookAddressResolver;
}) {
  const vault = options.encryptionKey ? createWebhookSecretVault(options.encryptionKey) : undefined;
  const requireVault = () => {
    if (!vault)
      throw new ApiError(
        503,
        "WEBHOOK_SIGNING_UNAVAILABLE",
        "Webhook creation and secret rotation require WEBHOOK_SIGNING_ENCRYPTION_KEY",
      );
    return vault;
  };
  const destination = async (value: string) => {
    try {
      return (await validateWebhookDestination(value, options.resolve)).url.toString();
    } catch {
      throw new ApiError(
        400,
        "INVALID_WEBHOOK_DESTINATION",
        "Provide a public HTTP or HTTPS webhook URL without credentials or fragments",
      );
    }
  };
  const run = <T>(
    principal: WebhookPrincipal,
    scope: WebhookScope,
    writing: boolean,
    operation: (transaction: Transaction) => Promise<T>,
  ) =>
    options.database.transaction(async (transaction) => {
      await transaction.execute(sql`set local statement_timeout = '15s'`);
      await transaction.execute(sql`set local lock_timeout = '5s'`);
      await authorizeWebhookScope(transaction, principal, scope, writing);
      return operation(transaction);
    });
  const lockedEndpoint = async (transaction: Transaction, scope: WebhookScope, id: string) => {
    const [endpoint] = await transaction
      .select()
      .from(schema.webhookEndpoint)
      .where(endpointFilter(scope, id))
      .for("update");
    if (!endpoint) throw notFound();
    return endpoint;
  };
  return {
    list(
      principal: WebhookPrincipal,
      scope: WebhookScope,
      pagination: { limit: number; offset: number },
    ) {
      return run(principal, scope, false, async (transaction) => {
        const endpoints = await transaction
          .select()
          .from(schema.webhookEndpoint)
          .where(endpointFilter(scope))
          .orderBy(desc(schema.webhookEndpoint.createdAt), desc(schema.webhookEndpoint.id))
          .limit(pagination.limit)
          .offset(pagination.offset);
        const [count] = await transaction
          .select({ total: sql<number>`count(*)::int` })
          .from(schema.webhookEndpoint)
          .where(endpointFilter(scope));
        return {
          endpoints: endpoints.map(publicEndpoint),
          pagination: { ...pagination, total: count?.total ?? 0 },
        };
      });
    },
    get(principal: WebhookPrincipal, scope: WebhookScope, id: string) {
      return run(principal, scope, false, async (transaction) => {
        const [endpoint] = await transaction
          .select()
          .from(schema.webhookEndpoint)
          .where(endpointFilter(scope, id));
        if (!endpoint) throw notFound();
        return publicEndpoint(endpoint);
      });
    },
    create(principal: WebhookPrincipal, scope: WebhookScope, input: CreateWebhookInput) {
      return run(principal, scope, true, async (transaction) => {
        const signing = requireVault();
        const url = await destination(input.url);
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`webhook-configuration:${scope.projectId}:${scope.environmentId}`}, 0))`,
        );
        const [count] = await transaction
          .select({ total: sql<number>`count(*)::int` })
          .from(schema.webhookEndpoint)
          .where(endpointFilter(scope));
        if ((count?.total ?? 0) >= 100)
          throw new ApiError(
            409,
            "WEBHOOK_ENDPOINT_LIMIT",
            "An environment supports at most 100 webhook endpoints",
          );
        const identity = { ...scope, id: `webhook_${randomUUID()}`, signingSecretVersion: 1 };
        const signingSecret = signing.generate();
        const [endpoint] = await transaction
          .insert(schema.webhookEndpoint)
          .values({
            ...identity,
            ...input,
            url,
            encryptedSigningSecret: signing.encrypt(signingSecret, webhookSecretContext(identity)),
          })
          .returning();
        if (!endpoint) throw new Error("Webhook creation did not return a configuration");
        return {
          ...publicEndpoint(endpoint),
          signingSecret,
          rotationPolicy: "immediate replacement" as const,
        };
      });
    },
    update(
      principal: WebhookPrincipal,
      scope: WebhookScope,
      id: string,
      input: UpdateWebhookInput,
    ) {
      return run(principal, scope, true, async (transaction) => {
        const current = await lockedEndpoint(transaction, scope, id);
        const url =
          input.url !== undefined || input.status === "enabled"
            ? await destination(input.url ?? current.url)
            : current.url;
        const [endpoint] = await transaction
          .update(schema.webhookEndpoint)
          .set({ ...input, url, updatedAt: new Date() })
          .where(endpointFilter(scope, id))
          .returning();
        if (!endpoint) throw notFound();
        return publicEndpoint(endpoint);
      });
    },
    rotate(principal: WebhookPrincipal, scope: WebhookScope, id: string) {
      return run(principal, scope, true, async (transaction) => {
        const signing = requireVault();
        const current = await lockedEndpoint(transaction, scope, id);
        const identity = { ...scope, id, signingSecretVersion: current.signingSecretVersion + 1 };
        const signingSecret = signing.generate();
        const [endpoint] = await transaction
          .update(schema.webhookEndpoint)
          .set({
            encryptedSigningSecret: signing.encrypt(signingSecret, webhookSecretContext(identity)),
            signingSecretVersion: identity.signingSecretVersion,
            signingSecretRotatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(endpointFilter(scope, id))
          .returning();
        if (!endpoint) throw notFound();
        return {
          ...publicEndpoint(endpoint),
          signingSecret,
          rotationPolicy: "immediate replacement" as const,
        };
      });
    },
    remove(principal: WebhookPrincipal, scope: WebhookScope, id: string) {
      return run(principal, scope, true, async (transaction) => {
        await lockedEndpoint(transaction, scope, id);
        await transaction
          .update(schema.webhookEndpoint)
          .set({ status: "disabled", deletedAt: new Date(), updatedAt: new Date() })
          .where(endpointFilter(scope, id));
      });
    },
  };
}
