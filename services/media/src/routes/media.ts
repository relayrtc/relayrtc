import { sql } from "drizzle-orm";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { RoomQualityMode } from "@relayrtc/types";
import type { FastifyPluginCallback } from "fastify";

import { MediaEngineError } from "../engine/errors.js";
import { registerInternalAuthentication } from "../authentication/internal-auth.js";
import type {
  MediaEngine,
  MediaKind,
  MediaTrackType,
  MediaTransportDirection,
} from "../engine/media-engine.js";
import type { MediaPriority, SubscriberQualityMode } from "../engine/quality-controller.js";

interface MediaRoutesOptions {
  rememberGuest?: (roomId: string, sessionId: string) => void;
  database?: RelayKitDatabase;
  engine: MediaEngine;
  internalSecret: string;
}

interface RoomParameters {
  roomId: string;
}

interface TransportBody {
  direction: MediaTransportDirection;
  participantId: string;
}

interface ConnectTransportBody {
  dtlsParameters: Readonly<Record<string, unknown>>;
  participantId: string;
}

interface OwnedTransportBody {
  participantId: string;
}

interface TransportParameters extends RoomParameters {
  transportId: string;
}

interface PublishTrackBody {
  sourceHeight?: number;
  kind: MediaKind;
  participantId: string;
  rtpParameters: Readonly<Record<string, unknown>>;
  transportId: string;
  trackType: MediaTrackType;
  priority?: MediaPriority;
}

interface SubscribeTrackBody {
  participantId: string;
  rtpCapabilities: Readonly<Record<string, unknown>>;
  trackId: string;
  transportId: string;
  quality?: SubscriberQualityMode;
}

interface ParticipantParameters extends RoomParameters {
  participantId: string;
}
interface SubscriptionParameters extends RoomParameters {
  subscriptionId: string;
}
interface PriorityBody {
  priority: MediaPriority;
}
interface QualityBody {
  participantId: string;
  quality: SubscriberQualityMode;
}
interface SubscriptionOwnerBody {
  participantId: string;
}
interface QualityModeBody {
  mode: RoomQualityMode;
}
interface StatsBody {
  transportId?: string;
  publicParticipantId?: string;
  participantId: string;
  stats: {
    packetLossRatio?: number | null;
    incomingBitrate?: number | null;
    stale?: boolean;
    availableIncomingBitrate: number | null;
    jitter: number | null;
    packetsLost: number;
    packetsReceived: number;
    roundTripTime: number | null;
    timestamp: number;
    turnBytesReceived?: number;
    turnBytesSent?: number;
  };
}

interface TrackParameters extends RoomParameters {
  participantId: string;
  trackId: string;
}

const roomParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["roomId"],
  properties: { roomId: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

const rtcParametersSchema = { type: "object", additionalProperties: true } as const;

export const mediaRoutes: FastifyPluginCallback<MediaRoutesOptions> = (app, options, done) => {
  const database = options.database;
  registerInternalAuthentication(
    app,
    options.internalSecret,
    database
      ? async (request, claims) => {
          if (claims.authority.kind !== "participant") return true;
          if (claims.authority.subjectId && !claims.authority.subjectId.startsWith("guestp_"))
            return true;
          const body = request.body as { trackType?: string } | undefined;
          const permission =
            request.method === "POST" && request.routeOptions.url?.endsWith("/tracks")
              ? (body?.trackType ?? "")
              : "";
          const [row] = await database.execute(
            sql`SELECT guest_session_authorized(${claims.authority.sessionId},${permission}) AS ok,EXISTS(SELECT 1 FROM participant_session ps JOIN participant p ON p.id=ps.participant_id WHERE ps.id=${claims.authority.sessionId} AND left(p.id,7)='guestp_') AS guest`,
          );
          if (row?.guest === true)
            options.rememberGuest?.(claims.authority.roomId, claims.authority.sessionId);
          return row?.ok === true;
        }
      : undefined,
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MediaEngineError) {
      const statusCode =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "FORBIDDEN"
            ? 403
            : error.code === "INVALID_REQUEST"
              ? 400
              : error.code === "CAPACITY_EXCEEDED"
                ? 429
                : error.code === "NOT_READY"
                  ? 503
                  : 501;
      return reply.code(statusCode).send({ code: error.code, description: error.message });
    }
    throw error;
  });

  app.get("/capacity", () => options.engine.getCapacity());

  app.post<{ Params: RoomParameters }>(
    "/rooms/:roomId",
    { schema: { params: roomParametersSchema } },
    async (request, reply) => {
      await options.engine.createRoom(request.params);
      return reply.code(201).send({ roomId: request.params.roomId });
    },
  );

  app.delete<{ Params: RoomParameters }>(
    "/rooms/:roomId",
    { schema: { params: roomParametersSchema } },
    async (request, reply) => {
      await options.engine.closeRoom(request.params);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: RoomParameters }>(
    "/rooms/:roomId/capabilities",
    { schema: { params: roomParametersSchema } },
    async (request) => ({
      roomId: request.params.roomId,
      routerCapabilities: await options.engine.getRouterCapabilities(request.params),
    }),
  );

  app.get<{ Params: RoomParameters }>(
    "/rooms/:roomId/tracks",
    { schema: { params: roomParametersSchema } },
    async (request) => ({
      roomId: request.params.roomId,
      tracks: await options.engine.listPublishedTracks(request.params),
    }),
  );

  app.post<{ Body: TransportBody; Params: RoomParameters }>(
    "/rooms/:roomId/transports",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["direction", "participantId"],
          properties: {
            direction: { enum: ["receive", "send"] },
            participantId: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        params: roomParametersSchema,
      },
    },
    async (request, reply) => {
      const transport = await options.engine.createParticipantTransport({
        ...request.body,
        roomId: request.params.roomId,
      });
      return reply.code(201).send({ roomId: request.params.roomId, ...transport });
    },
  );

  app.patch<{ Body: ConnectTransportBody; Params: TransportParameters }>(
    "/rooms/:roomId/transports/:transportId",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["dtlsParameters", "participantId"],
          properties: {
            dtlsParameters: rtcParametersSchema,
            participantId: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      await options.engine.connectParticipantTransport({ ...request.body, ...request.params });
      return reply.code(204).send();
    },
  );

  app.post<{ Body: OwnedTransportBody; Params: TransportParameters }>(
    "/rooms/:roomId/transports/:transportId/restart-ice",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["participantId"],
          properties: { participantId: { type: "string", minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request) => ({
      iceParameters: await options.engine.restartParticipantTransport({
        ...request.body,
        ...request.params,
      }),
    }),
  );

  app.post<{ Body: PublishTrackBody; Params: RoomParameters }>(
    "/rooms/:roomId/tracks",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "participantId", "rtpParameters", "trackType", "transportId"],
          properties: {
            kind: { enum: ["audio", "video"] },
            participantId: { type: "string", minLength: 1, maxLength: 128 },
            rtpParameters: rtcParametersSchema,
            transportId: { type: "string", minLength: 1, maxLength: 256 },
            trackType: { enum: ["audio", "camera_video", "screen_audio", "screen_video"] },
            priority: { enum: ["high", "normal", "low"] },
            sourceHeight: { type: "number", minimum: 1, maximum: 16384 },
          },
        },
        params: roomParametersSchema,
      },
    },
    async (request, reply) => {
      const track = await options.engine.publishTrack({
        ...request.body,
        roomId: request.params.roomId,
      });
      return reply.code(201).send({ roomId: request.params.roomId, track });
    },
  );

  app.post<{ Body: SubscribeTrackBody; Params: RoomParameters }>(
    "/rooms/:roomId/subscriptions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["participantId", "rtpCapabilities", "trackId", "transportId"],
          properties: {
            participantId: { type: "string", minLength: 1, maxLength: 128 },
            rtpCapabilities: rtcParametersSchema,
            trackId: { type: "string", minLength: 1, maxLength: 256 },
            transportId: { type: "string", minLength: 1, maxLength: 256 },
            quality: { enum: ["auto", "1080p", "720p", "360p", "audio-only"] },
          },
        },
        params: roomParametersSchema,
      },
    },
    async (request, reply) => {
      const subscription = await options.engine.subscribeTrack({
        ...request.body,
        roomId: request.params.roomId,
      });
      return reply.code(201).send({ roomId: request.params.roomId, subscription });
    },
  );

  app.post<{ Body: StatsBody; Params: RoomParameters }>(
    "/rooms/:roomId/stats",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["participantId", "stats"],
          properties: {
            transportId: { type: "string", minLength: 1, maxLength: 256 },
            publicParticipantId: { type: "string", minLength: 1, maxLength: 128 },
            participantId: { type: "string", minLength: 1, maxLength: 128 },
            stats: {
              type: "object",
              additionalProperties: false,
              required: [
                "availableIncomingBitrate",
                "jitter",
                "packetsLost",
                "packetsReceived",
                "roundTripTime",
                "timestamp",
              ],
              properties: {
                availableIncomingBitrate: { type: ["number", "null"], minimum: 0 },
                jitter: { type: ["number", "null"], minimum: 0 },
                packetsLost: { type: "number", minimum: 0 },
                packetsReceived: { type: "number", minimum: 0 },
                roundTripTime: { type: ["number", "null"], minimum: 0 },
                timestamp: { type: "number", minimum: 0 },
                incomingBitrate: { type: ["number", "null"], minimum: 0 },
                packetLossRatio: { type: ["number", "null"], minimum: 0, maximum: 1 },
                stale: { type: "boolean" },
                turnBytesReceived: { type: "number", minimum: 0 },
                turnBytesSent: { type: "number", minimum: 0 },
              },
            },
          },
        },
        params: roomParametersSchema,
      },
    },
    async (request, reply) => {
      await options.engine.ingestSubscriberStats({
        ...request.body,
        roomId: request.params.roomId,
      });
      return reply.code(202).send({ accepted: true });
    },
  );

  app.patch<{ Body: SubscriptionOwnerBody; Params: SubscriptionParameters }>(
    "/rooms/:roomId/subscriptions/:subscriptionId/resume",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["participantId"],
          properties: { participantId: { type: "string", minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      await options.engine.resumeSubscription({ ...request.body, ...request.params });
      return reply.code(204).send();
    },
  );

  app.delete<{ Body: SubscriptionOwnerBody; Params: SubscriptionParameters }>(
    "/rooms/:roomId/subscriptions/:subscriptionId",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["participantId"],
          properties: { participantId: { type: "string", minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      if (!options.engine.removeSubscription) {
        return reply
          .code(501)
          .send({ code: "NOT_IMPLEMENTED", description: "Subscription removal is unavailable" });
      }
      await options.engine.removeSubscription({ ...request.body, ...request.params });
      return reply.code(204).send();
    },
  );

  app.patch<{ Body: QualityBody; Params: SubscriptionParameters }>(
    "/rooms/:roomId/subscriptions/:subscriptionId/quality",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["participantId", "quality"],
          properties: {
            participantId: { type: "string", minLength: 1, maxLength: 128 },
            quality: { enum: ["auto", "1080p", "720p", "360p", "audio-only"] },
          },
        },
      },
    },
    async (request, reply) => {
      await options.engine.setSubscriptionQuality({ ...request.body, ...request.params });
      return reply.code(204).send();
    },
  );

  app.patch<{ Body: PriorityBody; Params: ParticipantParameters }>(
    "/rooms/:roomId/participants/:participantId/priority",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["priority"],
          properties: { priority: { enum: ["high", "normal", "low"] } },
        },
      },
    },
    async (request, reply) => {
      await options.engine.setParticipantPriority({ ...request.body, ...request.params });
      return reply.code(204).send();
    },
  );

  app.patch<{ Body: QualityModeBody; Params: ParticipantParameters }>(
    "/rooms/:roomId/participants/:participantId/quality-mode",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: { mode: { enum: ["auto", "high", "balanced", "data-saver"] } },
        },
      },
    },
    async (request, reply) => {
      await options.engine.setParticipantQualityMode({ ...request.body, ...request.params });
      return reply.code(204).send();
    },
  );

  app.patch<{ Body: PriorityBody; Params: TrackParameters }>(
    "/rooms/:roomId/participants/:participantId/tracks/:trackId/priority",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["priority"],
          properties: { priority: { enum: ["high", "normal", "low"] } },
        },
      },
    },
    async (request, reply) => {
      await options.engine.setTrackPriority({ ...request.body, ...request.params });
      return reply.code(204).send();
    },
  );

  for (const action of ["pause", "resume"] as const) {
    app.patch<{ Params: TrackParameters }>(
      `/rooms/:roomId/participants/:participantId/tracks/:trackId/${action}`,
      async (request, reply) => {
        await options.engine.controlTrack({ ...request.params, action });
        return reply.code(204).send();
      },
    );
  }

  app.delete<{ Params: TrackParameters }>(
    "/rooms/:roomId/participants/:participantId/tracks/:trackId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["participantId", "roomId", "trackId"],
          properties: {
            participantId: { type: "string", minLength: 1, maxLength: 128 },
            roomId: { type: "string", minLength: 1, maxLength: 128 },
            trackId: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      await options.engine.removeTrack(request.params);
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: ParticipantParameters }>(
    "/rooms/:roomId/participants/:participantId",
    async (request, reply) => {
      await options.engine.removeParticipant(request.params);
      return reply.code(204).send();
    },
  );
  done();
};
