import { updateParticipantAccessSchema } from "@relayrtc/validation";
import { readParticipantAccess, updateParticipantAccess } from "../rooms/room-access.service.js";
import type { RelayKitDatabase } from "@relayrtc/database";
import {
  getRuntimeOperation,
  setAuditContext,
  processRuntimeOperation,
  type RoomTerminationConfig,
} from "@relayrtc/auth";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";

import { requireApiKeyScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { createRoomRepository } from "../rooms/room.repository.js";
import { roomParamsSchema } from "../rooms/room.schema.js";
import { createParticipantRepository } from "./participant.repository.js";
import { participantParamsSchema, listParticipantsQuerySchema } from "./participant.schema.js";
import { createParticipantService } from "./participant.service.js";

interface ParticipantRoutesOptions {
  database: RelayKitDatabase;
  runtimeConfig: RoomTerminationConfig;
}

const requestActor = (request: FastifyRequest) => {
  const principal = request.apiKey;
  if (!principal) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide a valid API key");
  return { type: "API_KEY" as const, id: principal.keyId, name: "API key" };
};

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

export const participantRoutes: FastifyPluginCallback<ParticipantRoutesOptions> = (
  app,
  options,
  done,
) => {
  const service = createParticipantService({
    participantRepository: createParticipantRepository(options.database),
    roomRepository: createRoomRepository(options.database),
    async removeRuntime(participant) {
      const operation = await processRuntimeOperation(
        options.database,
        options.runtimeConfig,
        `participant.remove:${participant.id}`,
      );
      if (!operation) throw new Error("Participant removal was not persisted");
      return operation;
    },
  });

  app.get(
    "/rooms/:roomId/participants",
    { preHandler: requireApiKeyScope("participants:read") },
    async (request) => {
      const params = validate(roomParamsSchema, request.params);
      const query = validate(listParticipantsQuerySchema, request.query);
      return service.list(requestScope(request), params.roomId, query);
    },
  );

  app.get(
    "/rooms/:roomId/participants/:participantId",
    { preHandler: requireApiKeyScope("participants:read") },
    async (request) => {
      const params = validate(participantParamsSchema, request.params);
      return service.get(requestScope(request), params.roomId, params.participantId);
    },
  );

  app.delete(
    "/rooms/:roomId/participants/:participantId",
    { preHandler: requireApiKeyScope("participants:remove") },
    async (request, reply) => {
      const params = validate(participantParamsSchema, request.params);
      await options.database.transaction(async transaction => {
        await setAuditContext(transaction, requestActor(request), request.id);
        const database = transaction as unknown as RelayKitDatabase;
        await createParticipantService({ participantRepository: createParticipantRepository(database), roomRepository: createRoomRepository(database) })
          .remove(requestScope(request), params.roomId, params.participantId);
      });
      const operation = await processRuntimeOperation(options.database, options.runtimeConfig, `participant.remove:${params.participantId}`);
      if (!operation) throw new Error("Participant removal was not persisted");
      if (operation.status !== "completed") return reply.status(202).send(operation);
      return reply.status(204).send();
    },
  );

  app.get(
    "/rooms/:roomId/participants/:participantId/runtime-operation",
    {
      preHandler: requireApiKeyScope("participants:read"),
    },
    async (request) => {
      const params = validate(participantParamsSchema, request.params);
      await service.get(requestScope(request), params.roomId, params.participantId);
      const operation = await getRuntimeOperation(
        options.database,
        `participant.remove:${params.participantId}`,
      );
      if (!operation)
        throw new ApiError(
          404,
          "OPERATION_NOT_FOUND",
          "No removal operation exists for this participant",
        );
      return operation;
    },
  );

  app.get("/rooms/:roomId/participants/:participantId/access", { preHandler: requireApiKeyScope("participants:read") }, async request => {
    const params = validate(participantParamsSchema, request.params);
    await service.get(requestScope(request), params.roomId, params.participantId);
    return readParticipantAccess(options.database, params.roomId, params.participantId);
  });

  app.put("/rooms/:roomId/participants/:participantId/access", { preHandler: requireApiKeyScope("participants:write") }, async request => {
    const params = validate(participantParamsSchema, request.params);
    const input = validate(updateParticipantAccessSchema, request.body);
    const actor = requestActor(request);
    return options.database.transaction(async transaction => {
      return updateParticipantAccess(transaction, requestScope(request), params.roomId, params.participantId, input,
        actor, request.id);
    });
  });

  done();
};
