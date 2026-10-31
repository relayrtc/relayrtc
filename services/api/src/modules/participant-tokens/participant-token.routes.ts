import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";

import { requireApiKeyScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { createRoomRepository } from "../rooms/room.repository.js";
import { roomParamsSchema } from "../rooms/room.schema.js";
import {
  createParticipantTokenBodySchema,
  renewParticipantTokenBodySchema,
} from "./participant-token.schema.js";
import { createParticipantTokenRenewalService } from "./participant-token-renewal.service.js";
import { createActiveRenewalSession } from "./participant-token-renewal.repository.js";
import type { ParticipantTokenVerifier } from "./participant-token.verifier.js";
import { createParticipantTokenService } from "./participant-token.service.js";
import type { ParticipantTokenSigner } from "./participant-token.signer.js";
import { requireTokenAdmission } from "../rooms/room-lifecycle.service.js";

interface ParticipantTokenRoutesOptions {
  database: RelayKitDatabase;
  signer: ParticipantTokenSigner;
  verifier: ParticipantTokenVerifier;
}

const requestScope = (request: FastifyRequest) => {
  const principal = request.apiKey;
  if (!principal) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide a valid API key");
  }

  return {
    environmentId: principal.environmentId,
    projectId: principal.projectId,
  };
};

export const participantTokenRoutes: FastifyPluginCallback<ParticipantTokenRoutesOptions> = (
  app,
  options,
  done,
) => {
  const renewal = createParticipantTokenRenewalService({
    signer: options.signer,
    verifier: options.verifier,
    withActiveSession: createActiveRenewalSession(options.database),
  });
  const service = createParticipantTokenService({
    requireAdmission: roomId=>requireTokenAdmission(options.database,roomId),
    isProjectActive: async ({ projectId, environmentId }) => {
      const [project] = await options.database
        .select({ status: schema.project.status })
        .from(schema.project)
        .where(
          and(
            eq(schema.project.id, projectId),
            sql`EXISTS (
          SELECT 1 FROM environment e JOIN organization o ON o.id = ${schema.project.organizationId}
          WHERE e.id = ${environmentId} AND e.project_id = ${schema.project.id}
            AND e.status = 'active' AND o.status = 'active'
        )`,
          ),
        );
      return project?.status === "active";
    },
    roomRepository: createRoomRepository(options.database),
    signer: options.signer,
  });

  app.post(
    "/rooms/:roomId/tokens",
    { preHandler: requireApiKeyScope("tokens:create") },
    async (request, reply) => {
      const params = validate(roomParamsSchema, request.params);
      const body = validate(createParticipantTokenBodySchema, request.body);
      const token = await service.create(requestScope(request), params.roomId, body);
      return reply.status(201).send(token);
    },
  );

  app.post(
    "/rooms/:roomId/tokens/renew",
    { preHandler: requireApiKeyScope("tokens:create") },
    async (request, reply) => {
      const params = validate(roomParamsSchema, request.params);
      const body = validate(renewParticipantTokenBodySchema, request.body);
      const token = await renewal.renew(requestScope(request), params.roomId, body);
      return reply.header("cache-control", "no-store").status(201).send(token);
    },
  );

  done();
};
