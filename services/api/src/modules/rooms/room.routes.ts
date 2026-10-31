import { roomAuditQuerySchema } from "@relayrtc/validation";
import { readRoomAudit } from "./room-access.service.js";
import { getRuntimeOperation, setAuditContext } from "@relayrtc/auth";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";

import { requireApiKeyScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { createRoomRepository } from "./room.repository.js";
import { createRoomBodySchema, listRoomsQuerySchema, roomParamsSchema } from "./room.schema.js";
import { createRoomService } from "./room.service.js";
import type { RoomRuntimeService } from "./room-runtime.service.js";

interface RoomRoutesOptions {
  database: RelayKitDatabase;
  roomRuntime: RoomRuntimeService;
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

export const roomRoutes: FastifyPluginCallback<RoomRoutesOptions> = (app, options, done) => {
  const service = createRoomService(createRoomRepository(options.database), options.roomRuntime);

  app.post("/rooms", { preHandler: requireApiKeyScope("rooms:create") }, async (request, reply) => {
    const body = validate(createRoomBodySchema, request.body);
    const room = await options.database.transaction(async transaction => {
      await setAuditContext(transaction, requestActor(request), request.id);
      return createRoomService(createRoomRepository(transaction as unknown as RelayKitDatabase)).create(requestScope(request), body);
    });
    return reply.status(201).send(room);
  });

  app.get("/rooms", { preHandler: requireApiKeyScope("rooms:read") }, async (request) => {
    const query = validate(listRoomsQuerySchema, request.query);
    return service.list(requestScope(request), query);
  });

  app.get("/rooms/:roomId", { preHandler: requireApiKeyScope("rooms:read") }, async (request) => {
    const params = validate(roomParamsSchema, request.params);
    return service.get(requestScope(request), params.roomId);
  });

  app.get(
    "/rooms/:roomId/runtime-operation",
    { preHandler: requireApiKeyScope("rooms:read") },
    async (request) => {
      const params = validate(roomParamsSchema, request.params);
      await service.get(requestScope(request), params.roomId);
      const operation = await getRuntimeOperation(options.database, `room.end:${params.roomId}`);
      if (!operation)
        throw new ApiError(404, "OPERATION_NOT_FOUND", "No cleanup operation exists for this room");
      return operation;
    },
  );

  app.delete(
    "/rooms/:roomId",
    { preHandler: requireApiKeyScope("rooms:end") },
    async (request, reply) => {
      const params = validate(roomParamsSchema, request.params);
      await options.database.transaction(async transaction => {
        await setAuditContext(transaction, requestActor(request), request.id);
        await createRoomService(createRoomRepository(transaction as unknown as RelayKitDatabase)).end(requestScope(request), params.roomId);
      });
      const ended = await createRoomRepository(options.database).find(requestScope(request), params.roomId);
      if (!ended) throw new ApiError(404, "ROOM_NOT_FOUND", "The room does not exist");
      const operation = await options.roomRuntime.end(ended);
      if (operation && operation.status !== "completed") return reply.status(202).send(operation);
      return reply.status(204).send();
    },
  );

  app.get("/rooms/:roomId/audit", { preHandler: requireApiKeyScope("rooms:read") }, async request => {
    const { roomId } = validate(roomParamsSchema, request.params);
    return readRoomAudit(options.database, requestScope(request), roomId, validate(roomAuditQuerySchema, request.query));
  });

  done();
};
