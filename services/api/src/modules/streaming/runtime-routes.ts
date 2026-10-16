import { timingSafeEqual } from "node:crypto";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import {
  signStreamingGrant,
  verifyStreamingGrant,
  streamingSecretHash,
  type StreamingClaims,
} from "@relayrtc/protocol/streaming-control";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { streamSourceInfoSchema } from "@relayrtc/validation";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import type { StreamingConfig } from "./config.js";
import { StreamingGateway, ingestPath, programPath } from "./gateway.js";
import { recordObservationGap, transition } from "./lifecycle.js";
import { getStream, secret, type Transaction, type SessionRow, conflict } from "./repository.js";
import { boundedBody } from "./store.js";

const tokenFor = (request: FastifyRequest) =>
  /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
export const equalSecret = (a: string, b: string) => {
  const x = Buffer.from(streamingSecretHash(a)),
    y = Buffer.from(streamingSecretHash(b));
  return timingSafeEqual(x, y);
};
const workerSchema = z.object({ workerId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u) }).strict();
const reportSchema = z
  .object({
    sequence: z.number().int().positive(),
    status: z.enum(["running", "failed", "stopped"]),
    error: z.enum(["ENCODER_EXITED", "SOURCE_UNAVAILABLE", "WORKER_SHUTDOWN"]).optional(),
    sourceInfo: streamSourceInfoSchema.optional(),
  })
  .strict();
export interface RuntimeOptions {
  database: RelayKitDatabase;
  config: StreamingConfig;
  mediaUrl: string;
  internalSecret: string;
}
export async function leased(
  db: Transaction,
  config: StreamingConfig,
  request: FastifyRequest,
): Promise<{ session: SessionRow; claims: StreamingClaims }> {
  const claims = verifyStreamingGrant(config.secret, tokenFor(request), "streaming-worker");
  if (claims?.action !== "work")
    throw new ApiError(401, "INVALID_WORKER_GRANT", "A current worker grant is required");
  const [session] = await db
    .select()
    .from(schema.streamingSession)
    .where(eq(schema.streamingSession.id, claims.sessionId))
    .for("update");
  if (
    session?.streamId !== claims.streamId ||
    session.leaseToken !== claims.sub ||
    session.generation !== claims.generation ||
    !session.leasedUntil ||
    session.leasedUntil.getTime() <= Date.now() ||
    ["ended", "failed"].includes(session.state)
  )
    throw new ApiError(409, "WORKER_FENCED", "This worker no longer owns the source session");
  return { session, claims };
}
export const runtimeRoutes: FastifyPluginAsync<RuntimeOptions> = (app, options) => {
  const { database, config } = options,
    gateway = new StreamingGateway(config);
  const grant = (session: SessionRow) =>
    signStreamingGrant(
      config.secret,
      {
        aud: "streaming-worker",
        sub: required(session.leaseToken),
        streamId: session.streamId,
        sessionId: session.id,
        generation: session.generation,
        action: "work",
      },
      30,
    );
  const gatewayGrant = (session: SessionRow, action: string) =>
    signStreamingGrant(
      config.secret,
      {
        aud: "streaming-gateway",
        sub: required(session.leaseToken),
        streamId: session.streamId,
        sessionId: session.id,
        generation: session.generation,
        action,
      },
      30,
    );
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  app.post("/internal/v1/streaming/claim", async (request) => {
    if (!equalSecret(tokenFor(request), config.workerKey))
      throw new ApiError(401, "INVALID_WORKER_KEY", "Worker authentication failed");
    const input = validate(workerSchema, request.body);
    return database.transaction(async (db) => {
      const [candidate] = await db
        .select()
        .from(schema.streamingSession)
        .where(
          sql`desired_state='running' AND state IN ('starting','live','reconnecting') AND attempts<3 AND available_at<=now() AND (leased_until IS NULL OR leased_until<now())`,
        )
        .orderBy(schema.streamingSession.availableAt)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return { job: null };
      const stream = await getStream(db, candidate.streamId);
      if (stream.status !== "active") return { job: null };
      if (stream.source.kind !== "room") {
        const source = await gateway.path(ingestPath(stream.id));
        if (!source?.ready) {
          await db.execute(
            sql`UPDATE streaming_session SET available_at=now()+interval '2 seconds' WHERE id=${candidate.id}`,
          );
          return { job: null };
        }
      }
      // Revoke the old output before granting a new generation.
      if (candidate.generation)
        await gateway.removePath(programPath(candidate.id, candidate.generation));
      if (candidate.generation) await recordObservationGap(db, candidate, stream);
      if (candidate.state === "live")
        await transition(db, candidate, "reconnecting", "WORKER_LEASE_EXPIRED");
      const [session] = await db
        .update(schema.streamingSession)
        .set({
          workerId: input.workerId,
          leaseToken: secret(),
          generation: candidate.generation + 1,
          attempts: candidate.attempts + 1,
          leasedUntil: new Date(Date.now() + 15000),
          lastHeartbeatAt: new Date(),
          sampleSequence: 0,
          ingressBytes: stream.source.kind === "room" ? 0 : candidate.ingressBytes,
          programBytes: 0,
        })
        .where(eq(schema.streamingSession.id, candidate.id))
        .returning();
      const path = programPath(required(session).id, required(session).generation);
      await gateway.ensurePath(path);
      if (stream.source.kind !== "room") await gateway.ensurePath(ingestPath(stream.id));
      const programUrl = new URL(`${config.gatewayRtsp.replace(/\/$/u, "")}/${path}`);
      programUrl.username = "worker";
      programUrl.password = gatewayGrant(required(session), "publish");
      const sourceUrl = new URL(
        `${config.gatewayRtsp.replace(/\/$/u, "")}/${ingestPath(stream.id)}`,
      );
      sourceUrl.username = "worker";
      sourceUrl.password = gatewayGrant(required(session), "read");
      return {
        job: {
          sessionId: required(session).id,
          streamId: stream.id,
          generation: required(session).generation,
          source: stream.source,
          profile: stream.profile,
          maxDurationSeconds: stream.maxDurationSeconds,
          token: grant(required(session)),
          programUrl: programUrl.toString(),
          sourceUrl: stream.source.kind === "room" ? null : sourceUrl.toString(),
          leaseSeconds: 15,
        },
      };
    });
  });
  app.post("/internal/v1/streaming/heartbeat", async (request) => {
    const input = validate(reportSchema, request.body);
    return database.transaction(async (db) => {
      const { session } = await leased(db, config, request),
        stream = await getStream(db, session.streamId);
      if (session.desiredState !== "running" || stream.status !== "active") return { stop: true };
      if (input.sequence <= session.sampleSequence) return { stop: false, token: grant(session) };
      if (input.status !== "running") {
        await gateway.removePath(programPath(session.id, session.generation));
        await db.execute(
          sql`UPDATE streaming_session SET leased_until=now(),available_at=now()+interval '2 seconds' WHERE id=${session.id}`,
        );
        await transition(db, session, "reconnecting", input.error ?? "ENCODER_EXITED");
        return { stop: true };
      }
      const output = await gateway.path(programPath(session.id, session.generation));
      const source =
        stream.source.kind === "room" ? null : await gateway.path(ingestPath(stream.id));
      let roomBytes: number | null = null;
      if (stream.source.kind === "room") {
        const body = JSON.stringify({
          exportId: `${session.id}_${String(session.generation)}`,
          action: "renew",
        });
        const authority = signStreamingGrant(
          options.internalSecret,
          {
            aud: "streaming-media",
            sub: session.id,
            sessionId: session.id,
            streamId: stream.id,
            generation: session.generation,
            action: streamingSecretHash(body),
          },
          15,
        );
        const response = await fetch(`${options.mediaUrl}/streaming/exports/control`, {
          method: "POST",
          headers: { authorization: `Bearer ${authority}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
        if (response.ok) {
          const stats = z.object({ bytes: z.number().nonnegative() }).parse(await response.json());
          roomBytes = stats.bytes;
        } else await response.body?.cancel();
      }
      const ingress = roomBytes ?? Number(source?.bytesReceived ?? session.ingressBytes),
        program = Number(output?.bytesReceived ?? session.programBytes),
        now = new Date();
      const start = session.lastHeartbeatAt ?? now,
        elapsed = Math.max(0, (now.getTime() - start.getTime()) / 1000);
      const observed =
        Boolean(output?.ready) &&
        program > session.programBytes &&
        (stream.source.kind === "room" ? roomBytes !== null : Boolean(source?.ready));
      const ingressDelta =
        ingress >= session.ingressBytes ? ingress - session.ingressBytes : ingress;
      const programDelta =
        program >= session.programBytes ? program - session.programBytes : program;
      const countersReset = ingress < session.ingressBytes || program < session.programBytes;
      if (elapsed > 0 && ingressDelta / elapsed > 2500000) {
        await db.execute(
          sql`UPDATE streaming_session SET desired_state='stopped',last_error='INGRESS_BITRATE_LIMIT' WHERE id=${session.id}`,
        );
        return { stop: true };
      }
      await db.execute(sql`INSERT INTO streaming_usage_sample(session_id,generation,sequence,stream_id,organization_id,project_id,environment_id,start_at,end_at,source_seconds,ingress_bytes,program_bytes,coverage)
        VALUES(${session.id},${session.generation},${input.sequence},${stream.id},${stream.organizationId},${stream.projectId},${stream.environmentId},${start.toISOString()},${now.toISOString()},${observed ? Math.min(elapsed, 10) : 0},${ingressDelta},${programDelta},${observed && elapsed <= 10 && !countersReset ? "observed" : "partial"}) ON CONFLICT DO NOTHING`);
      const [updated] = await db
        .update(schema.streamingSession)
        .set({
          leasedUntil: new Date(Date.now() + 15000),
          lastHeartbeatAt: now,
          sampleSequence: input.sequence,
          ingressBytes: ingress,
          programBytes: program,
          ingressBitrate: elapsed > 0 ? Math.round((ingressDelta * 8) / elapsed) : 0,
          programBitrate: elapsed > 0 ? Math.round((programDelta * 8) / elapsed) : 0,
          ...(input.sourceInfo ? { sourceInfo: input.sourceInfo } : {}),
          ...(observed && !session.startedAt ? { startedAt: now } : {}),
        })
        .where(eq(schema.streamingSession.id, session.id))
        .returning();
      if (observed) await transition(db, session, "live");
      else if (session.state === "live")
        await transition(db, session, "reconnecting", "SOURCE_UNAVAILABLE");
      return { stop: false, token: grant(required(updated)), ready: observed };
    });
  });
  const exportSchema = z
    .object({ ports: z.array(z.number().int().min(10000).max(65000).multipleOf(2)).min(1).max(12) })
    .strict();
  app.post("/internal/v1/streaming/room-export", async (request) => {
    const input = validate(exportSchema, request.body);
    return database.transaction(async (db) => {
      const { session } = await leased(db, config, request),
        stream = await getStream(db, session.streamId);
      if (
        session.desiredState !== "running" ||
        stream.status !== "active" ||
        stream.source.kind !== "room"
      )
        throw conflict("SOURCE_UNAVAILABLE", "This session has no active room source");
      const body = {
        exportId: `${session.id}_${String(session.generation)}`,
        roomId: stream.source.roomId,
        videoTrackIds: stream.profile.audioOnly ? [] : stream.source.videoTrackIds,
        audioTrackIds: stream.source.audioTrackIds,
        audioOnly: stream.profile.audioOnly,
        layout: stream.profile.layout,
        receiverIp: config.workerRtpIp,
        ports: input.ports,
      };
      const serialized = JSON.stringify(body),
        token = signStreamingGrant(
          options.internalSecret,
          {
            aud: "streaming-media",
            sub: session.id,
            sessionId: session.id,
            streamId: stream.id,
            generation: session.generation,
            action: streamingSecretHash(serialized),
          },
          15,
        );
      const response = await fetch(`${options.mediaUrl}/streaming/exports`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: serialized,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(
          409,
          "ROOM_EXPORT_UNAVAILABLE",
          "The selected room tracks are not available",
        );
      }
      return JSON.parse((await boundedBody(response, 131072)).toString()) as unknown;
    });
  });
  app.post("/internal/v1/streaming/room-export/:action", async (request) => {
    const { action } = validate(
      z.object({ action: z.enum(["resume", "close", "renew"]) }),
      request.params,
    );
    return database.transaction(async (db) => {
      const { session } = await leased(db, config, request);
      const body = JSON.stringify({
        exportId: `${session.id}_${String(session.generation)}`,
        action,
      });
      const token = signStreamingGrant(
        options.internalSecret,
        {
          aud: "streaming-media",
          sub: session.id,
          sessionId: session.id,
          streamId: session.streamId,
          generation: session.generation,
          action: streamingSecretHash(body),
        },
        15,
      );
      const response = await fetch(`${options.mediaUrl}/streaming/exports/control`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw conflict("ROOM_EXPORT_EXPIRED", "The room export is no longer available");
      }
      await response.body?.cancel();
      return { ok: true };
    });
  });
  return Promise.resolve();
};

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
