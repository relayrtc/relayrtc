import { updateParticipantAccessSchema, roomAuditQuerySchema } from "@relayrtc/validation";
import { createRoomActivityStream } from "./room-activity-stream.js";
import {roomActivityPolicySchema} from "@relayrtc/validation";
import {readRoomActivity,readRoomActivityPolicy,updateRoomActivityPolicy} from "../rooms/room-activity.service.js";
import { createRoomInvitationSchema,redeemRoomInvitationSchema,updateRoomLifecycleSchema } from "@relayrtc/validation";
import { requireTokenAdmission,readRoomLifecycle,updateRoomLifecycle,createRoomInvitation,listRoomInvitations,revokeRoomInvitation,redeemRoomInvitation } from "../rooms/room-lifecycle.service.js";
import { readParticipantAccess, updateParticipantAccess, readRoomAudit } from "../rooms/room-access.service.js";
import { getRuntimeOperation, type RuntimeOperationView } from "@relayrtc/auth";
import { recordAudit } from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { environmentIdSchema, participantIdSchema, projectIdSchema, roomIdSchema, sessionIdSchema } from "@relayrtc/validation";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { createRoomRepository } from "../rooms/room.repository.js";
import { createRoomService } from "../rooms/room.service.js";
import { createRoomBodySchema, listRoomsQuerySchema } from "../rooms/room.schema.js";
import { createParticipantRepository } from "../participants/participant.repository.js";
import { createParticipantService } from "../participants/participant.service.js";
import { createParticipantTokenService } from "../participant-tokens/participant-token.service.js";
import { createParticipantTokenBodySchema, participantPermissions } from "../participant-tokens/participant-token.schema.js";
import type { ParticipantTokenSigner } from "../participant-tokens/participant-token.signer.js";
import { authorizeRtcEnvironment, authorizeRtcProject, type RtcTransaction } from "./rtc-access.js";
import { emptyRoomStats, readRoomSession, readRoomSessions, readRoomStats, readRealtimeSummary, roomSessionsQuery } from "./room-console-data.js";

interface Options {
  database: RelayKitDatabase;
  signer?: ParticipantTokenSigner;
  current: (request: FastifyRequest) => Promise<{ user: { id: string; name?: string } }>;
}
const root = "/api/account/realtime/projects/:projectId";
const projectParams = z.object({ projectId: projectIdSchema });
const environmentParams = projectParams.extend({ environmentId: environmentIdSchema });
const roomParams = projectParams.extend({ roomId: roomIdSchema });
const participantParams = roomParams.extend({ participantId: participantIdSchema });
const unavailableRoom = () => new ApiError(404, "ROOM_NOT_FOUND", "This room is unavailable or you no longer have access.");
const publicOperation = (operation: RuntimeOperationView | null) => operation ? {
  id: operation.id, kind: operation.kind, status: operation.status, attempts: operation.attempts, completedAt: operation.completedAt,
} : null;
const databaseFor = (transaction: RtcTransaction) => transaction as unknown as RelayKitDatabase;

// Uses the existing room/participant services, token signer, database outbox,
// and runtime worker. No API key is generated or stored for console access.
export function registerRoomsRoutes(app: FastifyInstance, options: Options) {
  const streamRoomActivity = createRoomActivityStream(app);
  async function withProject<T>(request: FastifyRequest, projectId: string, writing: boolean,
    task: (transaction: RtcTransaction, access: Awaited<ReturnType<typeof authorizeRtcProject>>, user: { id: string; name?: string }) => Promise<T>) {
    const { user } = await options.current(request);
    return options.database.transaction(async transaction => {
      await transaction.execute(sql`set local statement_timeout = '15s'`);
      await transaction.execute(sql`set local lock_timeout = '5s'`);
      return task(transaction, await authorizeRtcProject(transaction, user.id, projectId, writing), user);
    });
  }
  async function withRoom<T>(request: FastifyRequest, params: { projectId: string; roomId: string }, writing: boolean,
    task: (transaction: RtcTransaction, context: Awaited<ReturnType<typeof roomContext>>, user: { id: string; name?: string }) => Promise<T>) {
    return withProject(request, params.projectId, writing, async (transaction, access, user) =>
      task(transaction, await roomContext(transaction, access, params.roomId), user));
  }
  async function roomContext(transaction: RtcTransaction, access: Awaited<ReturnType<typeof authorizeRtcProject>>, roomId: string) {
    const database = databaseFor(transaction);
    const [reference] = await transaction.select({ environmentId: schema.room.environmentId }).from(schema.room)
      .where(and(eq(schema.room.id, roomId), eq(schema.room.projectId, access.project.id)));
    if (!reference) throw unavailableRoom();
    const environment = await authorizeRtcEnvironment(transaction, access.project.id, reference.environmentId);
    const scope = { projectId: access.project.id, environmentId: environment.id };
    const room = await createRoomService(createRoomRepository(database)).get(scope, roomId);
    return { ...access, environment, scope, room };
  }
  async function overview(transaction: RtcTransaction, context: Awaited<ReturnType<typeof roomContext>>) {
    const database = databaseFor(transaction);
    const stats = await readRoomStats(database, context.scope, [context.room.id]);
    return { room: { ...context.room, stats: stats.get(context.room.id) ?? emptyRoomStats }, project: context.project,
      environment: context.environment, canOperate: context.canOperate, tokenPermissions: participantPermissions,
      tokenSigningAvailable: Boolean(options.signer), observedAt: new Date().toISOString(),
      operation: publicOperation(await getRuntimeOperation(database, `room.end:${context.room.id}`)) };
  }

  app.get(root, async request => {
    const { projectId } = validate(projectParams, request.params);
    return withProject(request, projectId, false, async (transaction, access) => ({ ...access,
      environments: await transaction.select().from(schema.environment).where(and(eq(schema.environment.projectId, projectId), eq(schema.environment.status, "active"))).orderBy(asc(schema.environment.createdAt)),
      tokenPermissions: participantPermissions, tokenSigningAvailable: Boolean(options.signer),
    }));
  });
  const environments = `${root}/environments/:environmentId`;
  app.get(`${environments}/summary`, async request => {
    const scope = validate(environmentParams, request.params);
    return withProject(request, scope.projectId, false, async transaction => {
      await authorizeRtcEnvironment(transaction, scope.projectId, scope.environmentId);
      return readRealtimeSummary(databaseFor(transaction), scope);
    });
  });
  app.get(`${environments}/rooms`, async request => {
    const scope = validate(environmentParams, request.params);
    const query = validate(listRoomsQuerySchema, request.query);
    return withProject(request, scope.projectId, false, async transaction => {
      await authorizeRtcEnvironment(transaction, scope.projectId, scope.environmentId);
      const database = databaseFor(transaction);
      const result = await createRoomService(createRoomRepository(database)).list(scope, query);
      const stats = await readRoomStats(database, scope, result.nodes.map(room => room.id));
      return { ...result, nodes: result.nodes.map(room => ({ ...room, stats: stats.get(room.id) ?? emptyRoomStats })), observedAt: new Date().toISOString() };
    });
  });
  app.post(`${environments}/rooms`, async (request, reply) => {
    const scope = validate(environmentParams, request.params);
    const input = validate(createRoomBodySchema, request.body);
    const room = await withProject(request, scope.projectId, true, async transaction => {
      await authorizeRtcEnvironment(transaction, scope.projectId, scope.environmentId);
      return createRoomService(createRoomRepository(databaseFor(transaction))).create(scope, input);
    });
    return reply.code(201).send({ ...room, stats: emptyRoomStats });
  });

  // Room IDs remain stable deep links, even when another project was selected.
  app.get("/api/account/realtime/rooms/:roomId", async request => {
    const { roomId } = validate(z.object({ roomId: roomIdSchema }), request.params);
    const { user } = await options.current(request);
    const [reference] = await options.database.select({ projectId: schema.room.projectId }).from(schema.room)
      .innerJoin(schema.project, eq(schema.project.id, schema.room.projectId))
      .innerJoin(schema.member, eq(schema.member.organizationId, schema.project.organizationId))
      .where(and(eq(schema.room.id, roomId), eq(schema.member.userId, user.id)));
    if (!reference) throw unavailableRoom();
    return withRoom(request, { projectId: reference.projectId, roomId }, false, overview);
  });
  app.get(`${root}/rooms/:roomId`, async request => withRoom(request, validate(roomParams, request.params), false, overview));
  app.get(`${root}/rooms/:roomId/activity`,async request=>withRoom(request,validate(roomParams,request.params),false,(transaction,context)=>readRoomActivity(databaseFor(transaction),context.room.id)));
  app.get(`${root}/rooms/:roomId/activity/events`, async (request, reply) => {
    const params = validate(roomParams, request.params);
    const { user } = await options.current(request);
    return streamRoomActivity(reply, user.id, () => withRoom(request, params, false,
      (transaction, context) => readRoomActivity(databaseFor(transaction), context.room.id)));
  });
  app.get(`${root}/rooms/:roomId/activity-policy`,async request=>withRoom(request,validate(roomParams,request.params),false,(transaction,context)=>readRoomActivityPolicy(databaseFor(transaction),context.room.id)));
  app.put(`${root}/rooms/:roomId/activity-policy`,async request=>withRoom(request,validate(roomParams,request.params),true,(transaction,context)=>updateRoomActivityPolicy(databaseFor(transaction),context.room.id,validate(roomActivityPolicySchema,request.body))));
  app.get(`${root}/rooms/:roomId/lifecycle`,async request=>withRoom(request,validate(roomParams,request.params),false,(transaction,context)=>readRoomLifecycle(databaseFor(transaction),context.room.id)));
  app.put(`${root}/rooms/:roomId/lifecycle`,async request=>withRoom(request,validate(roomParams,request.params),true,(transaction,context)=>updateRoomLifecycle(databaseFor(transaction),context.room.id,validate(updateRoomLifecycleSchema,request.body))));
  app.get(`${root}/rooms/:roomId/invitations`,async request=>withRoom(request,validate(roomParams,request.params),false,(transaction,context)=>{
    const {cursor}=validate(z.object({cursor:z.string().regex(/^rinv_[a-f0-9]{32}$/).optional()}).strict(),request.query);
    return listRoomInvitations(databaseFor(transaction),context.room.id,cursor);
  }));
  app.post(`${root}/rooms/:roomId/invitations`,async(request,reply)=>reply.header("cache-control","no-store").code(201).send(await withRoom(request,validate(roomParams,request.params),true,(transaction,context)=>createRoomInvitation(databaseFor(transaction),context.room.id,validate(createRoomInvitationSchema,request.body)))));
  app.delete(`${root}/rooms/:roomId/invitations/:invitationId`,async request=>{
    const params=validate(roomParams.extend({invitationId:z.string().regex(/^rinv_[a-f0-9]{32}$/)}),request.params);
    return withRoom(request,params,true,(transaction,context)=>revokeRoomInvitation(databaseFor(transaction),context.room.id,params.invitationId));
  });
  app.post(`${root}/rooms/:roomId/invitations/redeem`,async(request,reply)=>{
    if(!options.signer) throw new ApiError(503,"TOKEN_SIGNING_UNAVAILABLE","Participant token signing is unavailable");
    const signer=options.signer;
    return reply.header("cache-control","no-store").code(201).send(await withRoom(request,validate(roomParams,request.params),true,(transaction,context)=>redeemRoomInvitation(databaseFor(transaction),context.scope,context.room.id,validate(redeemRoomInvitationSchema,request.body),signer)));
  });
  app.post(`${root}/rooms/:roomId/end`, async (request, reply) => {
    const params = validate(roomParams, request.params);
    const { confirmationName } = validate(z.object({ confirmationName: z.string().min(1).max(120) }).strict(), request.body);
    await withRoom(request, params, true, async (transaction, context) => {
      if (confirmationName !== context.room.name) throw new ApiError(400, "ROOM_CONFIRMATION_MISMATCH", "Enter the room name to confirm.");
      await createRoomService(createRoomRepository(databaseFor(transaction))).end(context.scope, params.roomId);
    });
    const operation = publicOperation(await getRuntimeOperation(options.database, `room.end:${params.roomId}`));
    if (!operation) throw new ApiError(503, "RUNTIME_OPERATION_UNAVAILABLE", "The room state changed, but cleanup progress is temporarily unavailable. Refresh the room to try again.");
    return reply.code(operation.status === "completed" ? 200 : 202).send({ operation });
  });
  app.get(`${root}/rooms/:roomId/runtime-operation`, async request => withRoom(request, validate(roomParams, request.params), false, async (transaction, context) => ({ operation: publicOperation(await getRuntimeOperation(databaseFor(transaction), `room.end:${context.room.id}`)) })));
  app.get(`${root}/rooms/:roomId/sessions`, async request => {
    const query = validate(roomSessionsQuery, request.query);
    return withRoom(request, validate(roomParams, request.params), false, async (transaction, context) => readRoomSessions(databaseFor(transaction), context.scope, context.room.id, query));
  });
  app.get(`${root}/rooms/:roomId/sessions/:sessionId`, async request => {
    const { sessionId, ...params } = validate(roomParams.extend({ sessionId: sessionIdSchema }), request.params);
    return withRoom(request, params, false, async (transaction, context) => {
      const database = databaseFor(transaction);
      const result = await readRoomSession(database, context.scope, params.roomId, sessionId);
      if (!result) throw new ApiError(404, "SESSION_NOT_FOUND", "This participant connection is unavailable.");
      return { ...result, operation: publicOperation(await getRuntimeOperation(database, `participant.remove:${result.session.participantId}`)) };
    });
  });
  app.post(`${root}/rooms/:roomId/participants/:participantId/remove`, async (request, reply) => {
    const params = validate(participantParams, request.params);
    validate(z.object({ confirmed: z.literal(true) }).strict(), request.body);
    await withRoom(request, params, true, async (transaction, context) => {
      const database = databaseFor(transaction);
      await createParticipantService({ participantRepository: createParticipantRepository(database), roomRepository: createRoomRepository(database) }).remove(context.scope, params.roomId, params.participantId);
    });
    const operation = publicOperation(await getRuntimeOperation(options.database, `participant.remove:${params.participantId}`));
    if (!operation) throw new ApiError(503, "RUNTIME_OPERATION_UNAVAILABLE", "The participant was removed, but cleanup progress is temporarily unavailable. Refresh the connection to try again.");
    return reply.code(operation.status === "completed" ? 200 : 202).send({ operation });
  });
  app.get(`${root}/rooms/:roomId/participants/:participantId/access`, async request => {
    const params = validate(participantParams, request.params);
    return withRoom(request, params, false, transaction => readParticipantAccess(transaction, params.roomId, params.participantId));
  });
  app.put(`${root}/rooms/:roomId/participants/:participantId/access`, async request => {
    const params = validate(participantParams, request.params);
    const input = validate(updateParticipantAccessSchema, request.body);
    return withRoom(request, params, true, (transaction, context, user) => updateParticipantAccess(transaction, context.scope,
      params.roomId, params.participantId, input, { type: "USER", id: user.id, name: user.name ?? "User" }, request.id));
  });
  app.get(`${root}/rooms/:roomId/audit`, async request => {
    const params = validate(roomParams, request.params);
    const query = validate(roomAuditQuerySchema, request.query);
    return withRoom(request, params, false, (transaction, context) => readRoomAudit(transaction, context.scope, params.roomId, query));
  });
  app.post(`${root}/rooms/:roomId/tokens`, async (request, reply) => {
    const params = validate(roomParams, request.params);
    const body = validate(createParticipantTokenBodySchema, request.body);
    const signer = options.signer;
    if (!signer) throw new ApiError(503, "TOKEN_SIGNING_UNAVAILABLE", "Participant token signing is unavailable.");
    const result = await withRoom(request, params, true, async (transaction, context, user) => {
      const database = databaseFor(transaction);
      const token = await createParticipantTokenService({ roomRepository: createRoomRepository(database), signer, requireAdmission:roomId=>requireTokenAdmission(database,roomId), isProjectActive: () => Promise.resolve(true) }).create(context.scope, params.roomId, body);
      await recordAudit(database, { actor: { type: "USER", id: user.id, name: user.name ?? "User" }, action: "room.token_created", outcome: "SUCCESS", resourceType: "participant_token", resourceId: token.tokenId, organizationId: context.project.organizationId, subjectUserId: user.id, correlationId: request.id });
      return token;
    });
    return reply.code(201).send(result);
  });
}
