import { registerRequestLimits, readRequestLimits } from "./resource-limits.js";
import { randomUUID } from "node:crypto";

import { createRelayKitSessionVerifier } from "@relayrtc/auth/server";
import type { RelayKitDatabase } from "@relayrtc/database";
import Fastify, { type FastifyInstance } from "fastify";

import type { ApiConfig } from "./config/environment.js";
import { registerErrorHandling } from "./http/errors/error-handler.js";
import { createParticipantTokenSigner } from "./modules/participant-tokens/participant-token.signer.js";
import { createRoomRuntimeService } from "./modules/rooms/room-runtime.service.js";
import { createTurnCredentialService } from "./modules/turn-credentials/turn-credential.service.js";
import { createRetainedTurnCredentialIssuer } from "./modules/turn-credentials/turn-credential.repository.js";
import { registerTurnAllocationCollector } from "./modules/turn-credentials/turn-allocation-worker.js";
import { healthRoutes } from "./routes/health.js";
import { reportingRoutes } from "./modules/reporting/reporting.routes.js";
import { v1Routes } from "./routes/v1/index.js";
import { webhookRoutes } from "./modules/webhooks/webhook.routes.js";
import { registerWebhookDeliveryWorker } from "./modules/webhooks/webhook-worker.js";
import { registerRuntimeOperationWorker } from "./runtime/runtime-operation-worker.js";
import { registerUsageRetention } from "./modules/reporting/usage-retention-worker.js";
import { registerUsageAggregation } from "./modules/reporting/usage-aggregation-worker.js";
import { accountRoutes } from "./modules/account/account.routes.js";
import { registerAdministrativeAudit } from "./modules/account/administrative-audit.js";

interface BuildAppOptions {
  closeDatabase?: () => Promise<void>;
  config: ApiConfig;
  database: RelayKitDatabase;
  usageRetentionDays?: number;
}

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

export const buildApp = (options: BuildAppOptions): FastifyInstance => {
  const app = Fastify({
    bodyLimit: 1_048_576,
    connectionTimeout: 10_000,
    genReqId: (request) => {
      const requestId = request.headers["x-request-id"];
      return typeof requestId === "string" && requestIdPattern.test(requestId)
        ? requestId
        : randomUUID();
    },
    logger: {
      level: options.config.logLevel,
      serializers: {
        req: (request) => ({ method: request.method, url: (request.url.split("?")[0] ?? "").replace(/(\/api\/auth\/reset-password\/)[^/]+/u, "$1[REDACTED]") }),
      },
      redact: {
        censor: "[REDACTED]",
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "request.headers.authorization",
          "request.headers.cookie",
          'res.headers["set-cookie"]',
          "req.body.password",
          "req.body.currentPassword",
          "req.body.newPassword",
          "req.body.otp",
          "req.body.code",
        ],
      },
    },
    requestIdHeader: "x-request-id",
    requestTimeout: 30_000,
    trustProxy: options.config.trustProxy,
  });
  const participantTokenSigner = createParticipantTokenSigner({
    audience: options.config.participantTokenAudience,
    issuer: options.config.participantTokenIssuer,
    keyId: options.config.participantTokenKeyId,
    secret: options.config.participantTokenSigningSecret,
  });
  const turnCredentialIssuer = createRetainedTurnCredentialIssuer(
    options.database,
    createTurnCredentialService({
      secret: options.config.turnSharedSecret,
      stunUrls: options.config.turnStunUrls,
      ttlSeconds: options.config.turnCredentialTtlSeconds,
      turnUrls: options.config.turnUrls,
    }),
  );
  const runtimeConfig = {
    internalSecret: options.config.internalSecret,
    mediaUrl: options.config.mediaInternalUrl,
    signalingUrl: options.config.signalingInternalUrl,
  };
  const roomRuntime = createRoomRuntimeService({
    database: options.database,
    internalSecret: options.config.internalSecret,
    mediaUrl: options.config.mediaInternalUrl,
    signalingUrl: options.config.signalingInternalUrl,
  });

  registerErrorHandling(app);
  registerRequestLimits(app, options.config.requestLimits ?? readRequestLimits({}));
  if (options.config.accountAuth) {
    registerAdministrativeAudit(app, options.database);
    void app.register(accountRoutes, { database: options.database, environment: options.config.accountAuth });
  }

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  const stopUsageRetention =
    options.usageRetentionDays === undefined
      ? undefined
      : registerUsageRetention(app, options.database, options.usageRetentionDays);
  const stopRuntimeOperations = registerRuntimeOperationWorker(
    app,
    options.database,
    runtimeConfig,
  );
  const stopUsageAggregation =
    options.usageRetentionDays === undefined
      ? undefined
      : registerUsageAggregation(app, options.database, options.usageRetentionDays);
  const stopTurnAccounting = options.config.turnAccountingLogDirectory
    ? registerTurnAllocationCollector(
        app,
        options.database,
        options.config.turnAccountingLogDirectory,
        options.config.turnAccountingMetricsUrl,
      )
    : undefined;
  const stopWebhookDeliveries = options.config.webhookSigningEncryptionKey
    ? registerWebhookDeliveryWorker(app, options.database, options.config.webhookSigningEncryptionKey)
    : undefined;
  app.addHook("onClose", async () => {
    await stopWebhookDeliveries?.();
    await stopTurnAccounting?.();
    await stopRuntimeOperations();
    await stopUsageAggregation?.();
    await stopUsageRetention?.();
    await options.closeDatabase?.();
  });

  void app.register(healthRoutes, { database: options.database });
  void app.register(webhookRoutes, {
    database: options.database,
    projectRoutes: true,
    ...(options.config.webhookSigningEncryptionKey
      ? { encryptionKey: options.config.webhookSigningEncryptionKey }
      : {}),
    ...(options.config.consoleAuth
      ? {
          consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
          verifyConsoleSession: createRelayKitSessionVerifier({
            database: options.database,
            ...options.config.consoleAuth,
          }),
        }
      : {}),
    prefix: "/v1",
  });
  void app.register(reportingRoutes, {
    database: options.database,
    ...(options.config.consoleAuth
      ? {
          verifyConsoleSession: createRelayKitSessionVerifier({
            database: options.database,
            ...options.config.consoleAuth,
          }),
        }
      : {}),
    prefix: "/v1",
  });
  void app.register(v1Routes, {
    database: options.database,
    ...(options.config.webhookSigningEncryptionKey
      ? { webhookSigningEncryptionKey: options.config.webhookSigningEncryptionKey }
      : {}),
    ...(options.usageRetentionDays === undefined
      ? {}
      : { usageRetentionDays: options.usageRetentionDays }),
    participantTokenSigner,
    roomRuntime,
    runtimeConfig,
    turnCredentialIssuer,
    prefix: "/v1",
  });

  return app;
};
