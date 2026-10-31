import type { RelayKitDatabase } from "@relayrtc/database";
import type { RoomTerminationConfig } from "@relayrtc/auth";
import type { FastifyPluginCallback } from "fastify";

import { registerAuthentication } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import { participantTokenRoutes } from "../../modules/participant-tokens/participant-token.routes.js";
import type { ParticipantTokenSigner } from "../../modules/participant-tokens/participant-token.signer.js";
import type { ParticipantTokenVerifier } from "../../modules/participant-tokens/participant-token.verifier.js";
import { participantRoutes } from "../../modules/participants/participant.routes.js";
import { roomRoutes } from "../../modules/rooms/room.routes.js";
import { roomLifecycleRoutes } from "../../modules/rooms/room-lifecycle.routes.js";
import type { RoomRuntimeService } from "../../modules/rooms/room-runtime.service.js";
import { turnCredentialRoutes } from "../../modules/turn-credentials/turn-credential.routes.js";
import type { TurnCredentialIssuer } from "../../modules/turn-credentials/turn-credential.service.js";
import { usageRoutes } from "../../modules/usage/usage.routes.js";
import { webhookRoutes } from "../../modules/webhooks/webhook.routes.js";

interface V1RoutesOptions {
  database: RelayKitDatabase;
  participantTokenSigner: ParticipantTokenSigner;
  participantTokenVerifier: ParticipantTokenVerifier;
  roomRuntime: RoomRuntimeService;
  runtimeConfig: RoomTerminationConfig;
  turnCredentialIssuer: TurnCredentialIssuer;
  usageRetentionDays?: number;
  webhookSigningEncryptionKey?: string;
}

const contextResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "environmentId", "keyId", "keyType", "projectId", "scopes"],
  properties: {
    apiVersion: { type: "string" },
    environmentId: { type: "string" },
    keyId: { type: "string" },
    keyType: { enum: ["publishable", "secret"] },
    projectId: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
  },
} as const;

export const v1Routes: FastifyPluginCallback<V1RoutesOptions> = (app, options, done) => {
  void app.register(roomLifecycleRoutes, {database:options.database,signer:options.participantTokenSigner});
  registerAuthentication(app, options.database);

  void app.register(roomRoutes, { database: options.database, roomRuntime: options.roomRuntime });
  void app.register(participantTokenRoutes, {
    database: options.database,
    signer: options.participantTokenSigner,
    verifier: options.participantTokenVerifier,
  });
  void app.register(participantRoutes, {
    database: options.database,
    runtimeConfig: options.runtimeConfig,
  });
  void app.register(turnCredentialRoutes, { issuer: options.turnCredentialIssuer });
  void app.register(webhookRoutes, {
    database: options.database,
    ...(options.webhookSigningEncryptionKey
      ? { encryptionKey: options.webhookSigningEncryptionKey }
      : {}),
  });
  void app.register(usageRoutes, {
    database: options.database,
    ...(options.usageRetentionDays === undefined
      ? {}
      : { retentionDays: options.usageRetentionDays }),
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-relayrtc-api-version", "v1");
    return payload;
  });

  app.get("/", { schema: { response: { 200: contextResponseSchema } } }, (request) => {
    const principal = request.apiKey;
    if (!principal) {
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide a valid API key");
    }

    return {
      apiVersion: "v1",
      environmentId: principal.environmentId,
      keyId: principal.keyId,
      keyType: principal.keyType,
      projectId: principal.projectId,
      scopes: principal.scopes,
    };
  });

  done();
};
