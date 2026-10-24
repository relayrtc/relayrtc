import type { RelayKitDatabase } from "@relayrtc/database";
import { createApiKey, listProjectApiKeys, revokeApiKey, rotateApiKey } from "@relayrtc/auth/api-keys";
import { getProjectDetails } from "@relayrtc/auth/projects";
import {
  availableApiKeyScopes, createApiKeyInputSchema, revokeApiKeyInputSchema, rotateApiKeyInputSchema,
  createWebhookInputSchema, updateWebhookInputSchema, listWebhookQuerySchema, listWebhookDeliveriesQuerySchema,
  replayWebhookDeliveryInputSchema, projectIdSchema, environmentIdSchema, webhookEndpointIdSchema,
  webhookDeliveryIdSchema, webhookEventTypeSchema,
} from "@relayrtc/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { createWebhookService } from "../webhooks/webhook.service.js";
import { createWebhookDeliveryService } from "../webhooks/webhook-delivery.service.js";

interface Options {
  database: RelayKitDatabase;
  encryptionKey?: string;
  current: (request: FastifyRequest) => Promise<{ user: { id: string } }>;
}
const projectParams = z.object({ projectId: projectIdSchema });
const scopeParams = projectParams.extend({ environmentId: environmentIdSchema });
const endpointParams = scopeParams.extend({ endpointId: webhookEndpointIdSchema });
const deliveryParams = endpointParams.extend({ deliveryId: webhookDeliveryIdSchema });
const empty = z.object({}).strict();
const root = "/api/account/developer/projects/:projectId";

function unwrap<T>(result: { data: T | null; error: { code: string; description: string } | null }): T {
  if (result.error) {
    const { code, description } = result.error;
    if (code === "API_KEY_ACCESS_DENIED" || code === "PROJECT_ACCESS_DENIED")
      throw new ApiError(404, "PROJECT_NOT_FOUND", "This project is unavailable or you no longer have access.");
    const status = /FORBIDDEN/.test(code) ? 403 : /NOT_FOUND/.test(code) ? 404 : /REVOKED/.test(code) ? 409 : /INVALID|MISMATCH/.test(code) ? 400 : 503;
    throw new ApiError(status, code, description);
  }
  if (result.data === null) throw new ApiError(503, "DEVELOPER_SERVICE_UNAVAILABLE", "Developer services are temporarily unavailable.");
  return result.data;
}

// Cookie-authenticated adapter for the existing services. Registered within the
// account plugin so mutations retain trusted Origin checks and request limits.
export function registerDeveloperRoutes(app: FastifyInstance, options: Options) {
  const context = async (request: FastifyRequest) => ({ database: options.database, userId: (await options.current(request)).user.id });
  const principal = async (request: FastifyRequest) => ({ type: "session" as const, userId: (await options.current(request)).user.id });
  const webhooks = createWebhookService({ database: options.database, ...(options.encryptionKey ? { encryptionKey: options.encryptionKey } : {}) });
  const deliveries = createWebhookDeliveryService(options.database);

  app.get(root, async request => {
    const { projectId } = validate(projectParams, request.params);
    const details = unwrap(await getProjectDetails(await context(request), projectId));
    return { ...details, availableScopes: availableApiKeyScopes, eventTypes: webhookEventTypeSchema.options, signingConfigured: Boolean(options.encryptionKey) };
  });
  app.get(`${root}/api-keys`, async request => {
    const { projectId } = validate(projectParams, request.params);
    return { apiKeys: unwrap(await listProjectApiKeys(await context(request), projectId)) };
  });
  app.post(`${root}/api-keys`, async (request, reply) => {
    const { projectId } = validate(projectParams, request.params);
    const input = validate(createApiKeyInputSchema, request.body);
    if (input.projectId !== projectId) throw new ApiError(400, "PROJECT_SCOPE_MISMATCH", "Select the same project as the API key request.");
    return reply.code(201).send(unwrap(await createApiKey(await context(request), input)));
  });
  app.post(`${root}/api-keys/:apiKeyId/rotate`, async request => {
    const params = validate(projectParams.extend({ apiKeyId: z.string().min(1).max(128) }), request.params);
    validate(empty, request.body ?? {});
    return unwrap(await rotateApiKey(await context(request), validate(rotateApiKeyInputSchema, params)));
  });
  app.post(`${root}/api-keys/:apiKeyId/revoke`, async request => {
    const params = validate(projectParams.extend({ apiKeyId: z.string().min(1).max(128) }), request.params);
    validate(empty, request.body ?? {});
    return unwrap(await revokeApiKey(await context(request), validate(revokeApiKeyInputSchema, params)));
  });

  const base = `${root}/environments/:environmentId/webhooks`;
  app.get(base, async request => {
    const scope = validate(scopeParams, request.params);
    const query = validate(listWebhookQuerySchema.omit({ projectId: true, environmentId: true }), request.query);
    return webhooks.list(await principal(request), scope, query);
  });
  app.post(base, async (request, reply) => {
    const scope = validate(scopeParams, request.params);
    return reply.code(201).send(await webhooks.create(await principal(request), scope, validate(createWebhookInputSchema, request.body)));
  });
  app.get(`${base}/signature-contract`, async request => deliveries.contract(await principal(request), validate(scopeParams, request.params)));
  app.get(`${base}/:endpointId`, async request => {
    const { endpointId, ...scope } = validate(endpointParams, request.params);
    return webhooks.get(await principal(request), scope, endpointId);
  });
  app.post(`${base}/:endpointId/update`, async request => {
    const { endpointId, ...scope } = validate(endpointParams, request.params);
    return webhooks.update(await principal(request), scope, endpointId, validate(updateWebhookInputSchema, request.body));
  });
  app.post(`${base}/:endpointId/rotate-secret`, async request => {
    const { endpointId, ...scope } = validate(endpointParams, request.params);
    validate(empty, request.body ?? {});
    return webhooks.rotate(await principal(request), scope, endpointId);
  });
  app.post(`${base}/:endpointId/delete`, async request => {
    const { endpointId, ...scope } = validate(endpointParams, request.params);
    validate(empty, request.body ?? {});
    await webhooks.remove(await principal(request), scope, endpointId);
    return { success: true };
  });
  app.get(`${base}/:endpointId/deliveries`, async request => {
    const { endpointId, ...scope } = validate(endpointParams, request.params);
    const query = validate(listWebhookDeliveriesQuerySchema.omit({ projectId: true, environmentId: true }), request.query);
    return deliveries.list(await principal(request), scope, endpointId, query);
  });
  app.get(`${base}/:endpointId/deliveries/:deliveryId`, async request => {
    const { endpointId, deliveryId, ...scope } = validate(deliveryParams, request.params);
    return deliveries.get(await principal(request), scope, endpointId, deliveryId);
  });
  app.post(`${base}/:endpointId/deliveries/:deliveryId/replay`, async (request, reply) => {
    const { endpointId, deliveryId, ...scope } = validate(deliveryParams, request.params);
    const { expectedReplayCount } = validate(replayWebhookDeliveryInputSchema, request.body);
    return reply.code(202).send(await deliveries.replay(await principal(request), scope, endpointId, deliveryId, expectedReplayCount));
  });
}
