import { streamingUsageRoutes } from "./modules/streaming/usage-routes.js";
import { guestRoutes } from "./modules/streaming/guest-routes.js";
import { registerGuestMaintenance } from "./modules/streaming/guest-service.js";
import { dvrRoutes } from "./modules/streaming/dvr-routes.js";
import { dvrMediaRoutes } from "./modules/streaming/dvr-media.js";
import { mixerRoutes } from "./modules/streaming/mixer-routes.js";
import { mixerRuntimeRoutes } from "./modules/streaming/mixer-runtime.js";
import { registerMixerMaintenance } from "./modules/streaming/mixer-service.js";
import { clipRoutes } from "./modules/streaming/clip-routes.js";
import { registerClipMaintenance } from "./modules/streaming/clip-service.js";
import { restreamRoutes } from "./modules/streaming/restream-routes.js";
import { restreamRuntimeRoutes } from "./modules/streaming/restream-runtime.js";
import { registerRestreamMaintenance } from "./modules/streaming/restream-service.js";
import { scheduleRoutes } from "./modules/streaming/schedule-routes.js";
import { registerScheduleMaintenance } from "./modules/streaming/schedule-service.js";
import { recordingRoutes, assetMediaRoutes } from "./modules/streaming/recording-routes.js";
import { recordingRuntimeRoutes } from "./modules/streaming/recording-runtime.js";
import { registerRecordingMaintenance } from "./modules/streaming/recording-service.js";
import { registerRequestLimits, readRequestLimits } from "./resource-limits.js";
import { randomUUID } from "node:crypto";

import { createRelayKitSessionVerifier } from "@relayrtc/auth/server";
import type { RelayKitDatabase } from "@relayrtc/database";
import Fastify, { type FastifyInstance } from "fastify";

import type { ApiConfig } from "./config/environment.js";
import { registerErrorHandling } from "./http/errors/error-handler.js";
import { ApiError } from "./http/errors/api-error.js";
import { createParticipantTokenSigner } from "./modules/participant-tokens/participant-token.signer.js";
import { createParticipantTokenVerifier } from "./modules/participant-tokens/participant-token.verifier.js";
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
import { streamingRoutes } from "./modules/streaming/routes.js";
import { streamingMetricsRoutes } from "./modules/streaming/metrics.js";
import { destinationRoutes } from "./modules/streaming/destination-routes.js";
import { broadcastRoutes } from "./modules/streaming/broadcast-routes.js";
import { broadcastRuntimeRoutes } from "./modules/streaming/broadcast-runtime.js";
import { registerBroadcastMaintenance } from "./modules/streaming/broadcast-service.js";
import { runtimeRoutes } from "./modules/streaming/runtime-routes.js";
import { ingestRoutes } from "./modules/streaming/ingest-routes.js";
import { playbackRoutes } from "./modules/streaming/playback.js";
import { registerStreamingMaintenance } from "./modules/streaming/lifecycle.js";

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
        req: (request) => ({
          method: request.method,
          url: (request.url.split("?")[0] ?? "").replace(
            /(\/api\/auth\/reset-password\/)[^/]+/u,
            "$1[REDACTED]",
          ),
        }),
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
          "req.body.participantToken",
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
      managed: Boolean(options.config.turnManagedRealm),
      secret: options.config.turnSharedSecret,
      stunUrls: options.config.turnStunUrls,
      ttlSeconds: options.config.turnCredentialTtlSeconds,
      turnUrls: options.config.turnUrls,
    }),
    options.config.turnManagedRealm,
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
    void app.register(accountRoutes, {
      database: options.database,
      environment: options.config.accountAuth,
    });
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
        options.config.turnAllocationControl,
      )
    : undefined;
  const stopWebhookDeliveries = options.config.webhookSigningEncryptionKey
    ? registerWebhookDeliveryWorker(
        app,
        options.database,
        options.config.webhookSigningEncryptionKey,
      )
    : undefined;
  const stopStreaming = options.config.streaming
    ? registerStreamingMaintenance(app, options.database, options.config.streaming)
    : undefined;
  const stopBroadcasts = options.config.streaming
    ? registerBroadcastMaintenance(app, options.database, options.config.streaming)
    : undefined;
  const stopGuests = options.config.streaming
    ? registerGuestMaintenance(app, options.database, options.config.streaming)
    : undefined;
  const stopMixers = options.config.streaming
    ? registerMixerMaintenance(app, options.database, options.config.streaming)
    : undefined;
  const stopClips = options.config.streaming
    ? registerClipMaintenance(app, options.database, options.config.streaming)
    : undefined;
  const stopRecordings = options.config.streaming
    ? registerRecordingMaintenance(app, options.database, options.config.streaming)
    : undefined;
  const stopRestream = options.config.streaming
    ? registerRestreamMaintenance(app, options.database)
    : undefined;
  const stopSchedules = options.config.streaming
    ? registerScheduleMaintenance(app, options.database, options.config.streaming)
    : undefined;
  app.addHook("onClose", async () => {
    await stopRestream?.();
    await stopSchedules?.();
    await stopGuests?.();
    await stopMixers?.();
    await stopClips?.();
    await stopRecordings?.();
    await stopBroadcasts?.();
    await stopStreaming?.();
    await stopWebhookDeliveries?.();
    await stopTurnAccounting?.();
    await stopRuntimeOperations();
    await stopUsageAggregation?.();
    await stopUsageRetention?.();
    await options.closeDatabase?.();
  });

  void app.register(healthRoutes, { database: options.database });
  if (options.config.streaming) {
    const streamingOptions = { database: options.database, config: options.config.streaming };
    void app.register(streamingRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(broadcastRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(destinationRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(mixerRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(guestRoutes, {
      ...streamingOptions,
      participantSigner: {
        audience: options.config.participantTokenAudience,
        issuer: options.config.participantTokenIssuer,
        keyId: options.config.participantTokenKeyId,
        secret: options.config.participantTokenSigningSecret,
      },
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(dvrRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(clipRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(recordingRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(streamingUsageRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(scheduleRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(restreamRoutes, {
      ...streamingOptions,
      prefix: "/v1",
      ...(options.config.consoleAuth
        ? {
            consoleOrigin: new URL(options.config.consoleAuth.baseUrl).origin,
            verifyConsoleSession: createRelayKitSessionVerifier({
              database: options.database,
              ...options.config.consoleAuth,
            }),
          }
        : {}),
    });
    void app.register(mixerRuntimeRoutes, streamingOptions);
    void app.register(restreamRuntimeRoutes, streamingOptions);
    void app.register(recordingRuntimeRoutes, streamingOptions);
    void app.register(dvrMediaRoutes, streamingOptions);
    void app.register(assetMediaRoutes, streamingOptions);
    void app.register(broadcastRuntimeRoutes, streamingOptions);
    void app.register(runtimeRoutes, {
      ...streamingOptions,
      mediaUrl: options.config.mediaInternalUrl,
      internalSecret: options.config.internalSecret,
    });
    void app.register(ingestRoutes, streamingOptions);
    void app.register(streamingMetricsRoutes, streamingOptions);
    void app.register(playbackRoutes, streamingOptions);
  } else {
    // Keep optional-feature errors distinct from an unknown or outdated API route.
    const unavailable = () => {
      throw new ApiError(
        503,
        "STREAMING_DISABLED",
        "Streaming is disabled. Start the streaming services with pnpm docker:up:streaming.",
      );
    };
    for (const path of [
      "/v1/restream-sources",
      "/v1/restream-sources/*",
      "/v1/streams",
      "/v1/streams/*",
      "/v1/scheduled-broadcasts",
      "/v1/scheduled-broadcasts/*",
      "/v1/schedule-operations/*",
      "/v1/guests/*",
      "/v1/dvr/*",
      "/v1/mixers/*",
      "/v1/mixer-operations/*",
      "/v1/clips",
      "/v1/clips/*",
      "/v1/recordings",
      "/v1/recordings/*",
      "/v1/assets/*",
      "/assets/*",
      "/v1/broadcasts",
      "/v1/broadcasts/*",
      "/v1/streaming-operations/*",
    ])
      app.all(path, unavailable);
  }
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
    participantTokenVerifier: createParticipantTokenVerifier({
      audience: options.config.participantTokenAudience,
      issuer: options.config.participantTokenIssuer,
      keyId: options.config.participantTokenKeyId,
      secret: options.config.participantTokenSigningSecret,
    }),
    roomRuntime,
    runtimeConfig,
    turnCredentialIssuer,
    prefix: "/v1",
  });

  return app;
};
