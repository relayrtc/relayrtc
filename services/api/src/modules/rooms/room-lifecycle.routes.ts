import type { RelayKitDatabase } from "@relayrtc/database";
import type { ApiKeyScope } from "@relayrtc/types";
import {
  createRoomInvitationSchema,
  redeemRoomInvitationSchema,
  updateRoomLifecycleSchema,
} from "@relayrtc/validation";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireApiKeyScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import type { ParticipantTokenSigner } from "../participant-tokens/participant-token.signer.js";
import { roomParamsSchema } from "./room.schema.js";
import {
  authorizeRoomLifecycle,
  createRoomInvitation,
  listRoomInvitations,
  readRoomLifecycle,
  redeemRoomInvitation,
  revokeRoomInvitation,
  updateRoomLifecycle,
} from "./room-lifecycle.service.js";

export const roomLifecycleRoutes: FastifyPluginCallback<{
  database: RelayKitDatabase;
  signer: ParticipantTokenSigner;
}> = (app, options, done) => {
  const invitationParams = roomParamsSchema.extend({
    invitationId: z.string().regex(/^rinv_[a-f0-9]{32}$/),
  });
  const querySchema = z
    .object({
      cursor: z
        .string()
        .regex(/^rinv_[a-f0-9]{32}$/)
        .optional(),
    })
    .strict();
  const withRoom = async <T>(
    request: FastifyRequest,
    task: (
      database: RelayKitDatabase,
      roomId: string,
      scope: { projectId: string; environmentId: string },
    ) => Promise<T>,
  ) => {
    const principal = request.apiKey;
    if (!principal) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide a valid API key");
    const { roomId } = validate(
      z.object({ roomId: roomParamsSchema.shape.roomId }).loose(),
      request.params,
    );
    const scope = { projectId: principal.projectId, environmentId: principal.environmentId };
    return options.database.transaction(async (transaction) => {
      const database = transaction as unknown as RelayKitDatabase;
      await authorizeRoomLifecycle(
        database,
        scope,
        roomId,
        { type: "API_KEY", id: principal.keyId, name: "API key" },
        request.id,
      );
      return task(database, roomId, scope);
    });
  };
  const permission = (scope: ApiKeyScope) => ({ preHandler: requireApiKeyScope(scope) });
  app.get("/rooms/:roomId/lifecycle", permission("rooms:read"), async (request) =>
    withRoom(request, (database, roomId) => readRoomLifecycle(database, roomId)),
  );
  app.put("/rooms/:roomId/lifecycle", permission("rooms:write"), async (request) =>
    withRoom(request, (database, roomId) =>
      updateRoomLifecycle(database, roomId, validate(updateRoomLifecycleSchema, request.body)),
    ),
  );
  app.get("/rooms/:roomId/invitations", permission("rooms:read"), async (request) =>
    withRoom(request, (database, roomId) =>
      listRoomInvitations(database, roomId, validate(querySchema, request.query).cursor),
    ),
  );
  app.post("/rooms/:roomId/invitations", permission("rooms:write"), async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .code(201)
      .send(
        await withRoom(request, (database, roomId) =>
          createRoomInvitation(
            database,
            roomId,
            validate(createRoomInvitationSchema, request.body),
          ),
        ),
      ),
  );
  app.delete(
    "/rooms/:roomId/invitations/:invitationId",
    permission("rooms:write"),
    async (request) => {
      const { invitationId } = validate(invitationParams, request.params);
      return withRoom(request, (database, roomId) =>
        revokeRoomInvitation(database, roomId, invitationId),
      );
    },
  );
  app.post(
    "/rooms/:roomId/invitations/redeem",
    permission("tokens:create"),
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .code(201)
        .send(
          await withRoom(request, (database, roomId, scope) =>
            redeemRoomInvitation(
              database,
              scope,
              roomId,
              validate(redeemRoomInvitationSchema, request.body),
              options.signer,
            ),
          ),
        ),
  );
  app.get("/rooms/:roomId/activity",permission("rooms:read"),async request=>withRoom(request,(database,roomId)=>readRoomActivity(database,roomId)));
  app.get("/rooms/:roomId/activity-policy",permission("rooms:read"),async request=>withRoom(request,(database,roomId)=>readRoomActivityPolicy(database,roomId)));
  app.put("/rooms/:roomId/activity-policy",permission("rooms:write"),async request=>withRoom(request,(database,roomId)=>updateRoomActivityPolicy(database,roomId,validate(roomActivityPolicySchema,request.body))));
  done();
};
import {roomActivityPolicySchema} from "@relayrtc/validation";
import {readRoomActivity,readRoomActivityPolicy,updateRoomActivityPolicy} from "./room-activity.service.js";
