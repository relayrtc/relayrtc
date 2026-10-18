import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { signStreamingGrant, verifyStreamingGrant } from "@relayrtc/protocol/streaming-control";
import { streamingObjectNameSchema } from "@relayrtc/validation";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import type { StreamingConfig } from "./config.js";
import { equalSecret } from "./runtime-routes.js";
import { conflict, getStream, secret, type Transaction } from "./repository.js";
import {
  getBroadcast,
  reconcileBroadcast,
  releaseJob,
  retryJob,
  sampleJob,
  type JobRow,
} from "./broadcast-service.js";
import { StreamingOrigin } from "./playback.js";
import { destinationContext, destinationEvent, destinationVault } from "./destinations.js";

const tokenFor = (request: FastifyRequest) =>
  /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
const workerSchema = z
  .object({
    workerId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u),
    kinds: z
      .array(z.enum(["hls", "rtmp"]))
      .min(1)
      .max(2)
      .default(["hls"]),
  })
  .strict();
const reportSchema = z
  .object({
    sequence: z.number().int().positive(),
    status: z.enum(["running", "failed", "stopped"]),
    live: z.boolean().default(false),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    bitrate: z.number().nonnegative().max(1000000000).default(0),
    droppedFrames: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    error: z
      .enum([
        "OUTPUT_UNAVAILABLE",
        "WORKER_SHUTDOWN",
        "OUTPUT_TIMEOUT",
        "DESTINATION_ADDRESS_REJECTED",
        "DESTINATION_CONNECTION_FAILED",
        "DESTINATION_TLS_FAILED",
        "DESTINATION_ENCODER_FAILED",
      ])
      .optional(),
  })
  .strict();
async function leasedJob(db: Transaction, request: FastifyRequest, config: StreamingConfig) {
  const claims = verifyStreamingGrant(config.secret, tokenFor(request), "streaming-broadcast");
  if (claims?.action !== "work")
    throw new ApiError(401, "INVALID_OUTPUT_GRANT", "A current output worker grant is required");
  const [initial] = await db
    .select()
    .from(schema.broadcastJob)
    .where(eq(schema.broadcastJob.id, claims.sessionId));
  if (!initial) throw conflict("OUTPUT_FENCED", "The output attempt no longer exists");
  const run = await getBroadcast(db, initial.broadcastId, true);
  const [job] = await db
    .select()
    .from(schema.broadcastJob)
    .where(eq(schema.broadcastJob.id, initial.id))
    .for("update");
  if (
    job?.leaseToken !== claims.sub ||
    job.fence !== claims.generation ||
    run.streamId !== claims.streamId ||
    !job.leasedUntil ||
    job.leasedUntil.getTime() <= Date.now() ||
    !["running", "stopping"].includes(job.state)
  )
    throw conflict("OUTPUT_FENCED", "This worker no longer owns the output attempt");
  return { run, job };
}
export const broadcastRuntimeRoutes: FastifyPluginAsync<{
  database: RelayKitDatabase;
  config: StreamingConfig;
}> = (app, { database, config }) => {
  const origin = new StreamingOrigin(database, config);
  const grant = (job: JobRow, streamId: string) =>
    signStreamingGrant(
      config.secret,
      {
        aud: "streaming-broadcast",
        sub: required(job.leaseToken),
        streamId,
        sessionId: job.id,
        generation: job.fence,
        action: "work",
      },
      30,
    );
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  app.post("/internal/v1/broadcasts/claim", async (request) => {
    if (!equalSecret(tokenFor(request), config.workerKey))
      throw new ApiError(401, "INVALID_WORKER_KEY", "Worker authentication failed");
    const input = validate(workerSchema, request.body);
    if (!config.broadcastsEnabled) return { job: null, draining: true };
    // Selection is advisory. Recheck ownership after locking the run, then its job.
    const candidates = await database
      .select({ id: schema.broadcastJob.id, broadcastId: schema.broadcastJob.broadcastId })
      .from(schema.broadcastJob)
      .where(
        sql`kind=ANY(ARRAY[${sql.join(input.kinds.map((kind) => sql`${kind}`), sql`, `)}]::text[]) AND state IN ('queued','retry') AND desired_state='running' AND available_at<=now() AND attempts<3 AND EXISTS (
        SELECT 1 FROM broadcast_run b JOIN streaming_session s ON s.id=b.source_session_id
        WHERE b.id=broadcast_job.broadcast_id AND b.desired_state='running' AND s.state='live' AND s.desired_state='running'
        AND s.generation=b.source_generation AND s.leased_until>now()
      )`,
      )
      .orderBy(schema.broadcastJob.availableAt)
      .limit(20);
    for (const candidate of candidates) {
      const result = await database.transaction(async (db) => {
        const [run] = await db
          .select()
          .from(schema.broadcastRun)
          .where(eq(schema.broadcastRun.id, candidate.broadcastId))
          .for("update", { skipLocked: true });
        if (
          run?.desiredState !== "running" ||
          !run.sourceSessionId ||
          run.sourceGeneration === null
        )
          return null;
        const [job] = await db
          .select()
          .from(schema.broadcastJob)
          .where(eq(schema.broadcastJob.id, candidate.id))
          .for("update");
        if (
          !job ||
          !["queued", "retry"].includes(job.state) ||
          job.desiredState !== "running" ||
          job.availableAt.getTime() > Date.now() ||
          job.attempts >= 3
        )
          return null;
        const stream = await getStream(db, run.streamId);
        const [source] = await db
          .select()
          .from(schema.streamingSession)
          .where(eq(schema.streamingSession.id, run.sourceSessionId));
        if (
          stream.status !== "active" ||
          source?.state !== "live" ||
          source.desiredState !== "running" ||
          source.generation !== run.sourceGeneration ||
          !source.leasedUntil ||
          source.leasedUntil.getTime() <= Date.now()
        )
          return null;
        await db.execute(sql`SELECT pg_advisory_xact_lock(810035)`);
        const [capacity] = await db.execute(
          sql`SELECT count(*)::int AS total,count(*) FILTER (WHERE worker_id=${input.workerId})::int AS worker FROM broadcast_reservation`,
        );
        if (
          Number(capacity?.total) >= config.maxOutputJobs ||
          Number(capacity?.worker) >= config.maxOutputJobsPerWorker
        )
          return null;
        const [claimed] = await db
          .update(schema.broadcastJob)
          .set({
            state: "running",
            workerId: input.workerId,
            leaseToken: secret(),
            fence: job.fence + 1,
            attempts: job.attempts + 1,
            leasedUntil: new Date(Date.now() + 15000),
            lastHeartbeatAt: new Date(),
            sampleSequence: 0,
            observedLive: 0,
            observedBytes: 0,
            observedDropped: 0,
            bitrate: 0,
            sourceSessionId: source.id,
            sourceGeneration: source.generation,
          })
          .where(eq(schema.broadcastJob.id, job.id))
          .returning();
        if (!claimed) return null;
        const [output] = await db
          .select()
          .from(schema.broadcastOutput)
          .where(eq(schema.broadcastOutput.id, job.outputId));
        const destination =
          output?.kind === "rtmp" &&
          output.destinationId &&
          output.credentialVersion &&
          output.encryptedSecret
            ? {
                ...z
                  .object({ endpoint: z.string(), streamKey: z.string() })
                  .parse(
                    JSON.parse(
                      destinationVault(config).decrypt(
                        output.encryptedSecret,
                        destinationContext(output.destinationId, output.credentialVersion),
                      ),
                    ),
                  ),
                id: output.destinationId,
                profile: output.configuration.profile,
              }
            : undefined;
        if (job.kind === "rtmp" && !destination)
          throw conflict("DESTINATION_UNAVAILABLE", "The destination snapshot is unavailable.");
        await db
          .insert(schema.broadcastAttempt)
          .values({ jobId: claimed.id, fence: claimed.fence, workerId: input.workerId });
        await db.insert(schema.broadcastReservation).values({
          jobId: claimed.id,
          fence: claimed.fence,
          workerId: input.workerId,
          expiresAt: required(claimed.leasedUntil),
        });
        return {
          job: {
            id: claimed.id,
            broadcastId: run.id,
            outputId: claimed.outputId,
            kind: claimed.kind,
            ...(destination ? { destination } : {}),
            fence: claimed.fence,
            source: {
              streamId: run.streamId,
              sessionId: source.id,
              generation: source.generation,
              profile: stream.profile,
            },
            token: grant(claimed, run.streamId),
            leaseSeconds: 15,
          },
        };
      });
      if (result) return result;
    }
    return { job: null };
  });
  app.post("/internal/v1/broadcasts/heartbeat", (request) => {
    const input = validate(reportSchema, request.body);
    return database.transaction(async (db) => {
      const { run, job } = await leasedJob(db, request, config);
      if (input.sequence <= job.sampleSequence)
        return {
          stop:
            job.desiredState !== "running" ||
            run.desiredState !== "running" ||
            !config.broadcastsEnabled,
          token: grant(job, run.streamId),
        };
      const [source] = job.sourceSessionId
        ? await db
            .select()
            .from(schema.streamingSession)
            .where(eq(schema.streamingSession.id, job.sourceSessionId))
        : [];
      const sourceLive =
        source?.state === "live" &&
        source.desiredState === "running" &&
        source.generation === job.sourceGeneration &&
        source.leasedUntil !== null &&
        source.leasedUntil.getTime() > Date.now();
      const stop =
        job.desiredState !== "running" ||
        run.desiredState !== "running" ||
        !config.broadcastsEnabled;
      await sampleJob(
        db,
        job,
        run,
        input.sequence,
        input.status === "running" && input.live && sourceLive && !stop,
        input.status !== "running" || !sourceLive || !input.live,
        job.kind === "rtmp" ? Math.max(job.observedBytes, input.bytes) : 0,
        Math.max(job.observedDropped, input.droppedFrames),
      );
      if (job.kind === "rtmp" && input.live && sourceLive && !stop && !job.observedLive) {
        const [output] = await db
          .select()
          .from(schema.broadcastOutput)
          .where(eq(schema.broadcastOutput.id, job.outputId));
        if (output?.destinationId)
          await destinationEvent(db, run, "destination.connected", {
            destinationId: output.destinationId,
            broadcastId: run.id,
            outputId: job.outputId,
            fence: job.fence,
            correlationId: run.correlationId,
          });
      }
      await db
        .update(schema.broadcastJob)
        .set({
          sampleSequence: input.sequence,
          lastHeartbeatAt: new Date(),
          observedLive: input.live && sourceLive && !stop ? 1 : 0,
          bitrate: input.bitrate,
        })
        .where(eq(schema.broadcastJob.id, job.id));
      const accounted = await getBroadcast(db, run.id);
      if (job.kind === "rtmp" && accounted.egressBytes >= config.maxEgressBytes && !stop) {
        await db
          .update(schema.broadcastJob)
          .set({
            state: "stopping",
            desiredState: "cancelled",
            lastError: "EGRESS_BYTE_LIMIT",
            observedLive: 0,
          })
          .where(eq(schema.broadcastJob.id, job.id));
        await db.execute(
          sql`UPDATE streaming_operation SET status='failed',error_code='EGRESS_BYTE_LIMIT',completed_at=now() WHERE output_id=${job.outputId} AND kind='broadcast.output.retry' AND status='pending'`,
        );
        const [output] = await db
          .select()
          .from(schema.broadcastOutput)
          .where(eq(schema.broadcastOutput.id, job.outputId));
        if (output?.destinationId)
          await destinationEvent(db, run, "destination.failed", {
            destinationId: output.destinationId,
            broadcastId: run.id,
            outputId: job.outputId,
            fence: job.fence,
            reason: "EGRESS_BYTE_LIMIT",
            correlationId: run.correlationId,
          });
        await reconcileBroadcast(db, accounted, config);
        return { stop: true };
      }
      if (
        input.status !== "running" &&
        job.desiredState !== "cancelled" &&
        run.desiredState === "running" &&
        config.broadcastsEnabled
      ) {
        await retryJob(
          db,
          job,
          job.desiredState === "restart"
            ? "SOURCE_GENERATION_CHANGED"
            : (input.error ??
                (input.status === "stopped" ? "WORKER_INTERRUPTED" : "OUTPUT_UNAVAILABLE")),
        );
      } else if (input.status === "stopped" || (input.status === "failed" && stop)) {
        await releaseJob(
          db,
          job,
          job.lastError === "EGRESS_BYTE_LIMIT" ? "EGRESS_BYTE_LIMIT" : "CANCELLED",
        );
        await db
          .update(schema.broadcastJob)
          .set({
            state: job.lastError === "EGRESS_BYTE_LIMIT" ? "failed" : "cancelled",
            desiredState: "cancelled",
            fence: job.fence + 1,
          })
          .where(eq(schema.broadcastJob.id, job.id));
      } else if (input.status === "failed")
        await retryJob(db, job, input.error ?? "OUTPUT_UNAVAILABLE");
      else if (!stop) {
        const expires = new Date(Date.now() + 15000);
        await db
          .update(schema.broadcastJob)
          .set({ leasedUntil: expires })
          .where(eq(schema.broadcastJob.id, job.id));
        await db
          .update(schema.broadcastReservation)
          .set({ expiresAt: expires })
          .where(eq(schema.broadcastReservation.jobId, job.id));
      }
      await reconcileBroadcast(db, await getBroadcast(db, run.id), config);
      return {
        stop: stop || input.status !== "running",
        token: input.status === "running" ? grant(job, run.streamId) : undefined,
      };
    });
  });
  app.post("/internal/v1/broadcasts/source", async (request) => {
    validate(z.object({}).strict(), request.body ?? {});
    const attachment = await database.transaction(async (db) => {
      const { run, job } = await leasedJob(db, request, config);
      if (
        !config.broadcastsEnabled ||
        run.desiredState !== "running" ||
        job.desiredState !== "running" ||
        !job.sourceSessionId ||
        job.sourceGeneration === null
      )
        throw conflict("OUTPUT_CANCELLED", "The output is being stopped");
      const stream = await getStream(db, run.streamId);
      const [source] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, job.sourceSessionId));
      if (
        stream.status !== "active" ||
        source?.state !== "live" ||
        source.desiredState !== "running" ||
        source.generation !== job.sourceGeneration ||
        !source.leasedUntil ||
        source.leasedUntil.getTime() <= Date.now()
      )
        throw conflict("SOURCE_UNAVAILABLE", "The canonical source is unavailable");
      return { stream, source };
    });
    // Each adapter has its own bounded read. A stalled output never blocks source encoding.
    let name = "index.m3u8",
      bytes = 0;
    for (let depth = 0; depth < 3; depth++) {
      const body = await origin.media(
        attachment.stream,
        attachment.source,
        name,
        attachment.source.generation,
      );
      bytes += body.length;
      if (!name.endsWith("m3u8")) break;
      const playlist = body.toString();
      if (!playlist.startsWith("#EXTM3U"))
        throw conflict("OUTPUT_UNAVAILABLE", "The HLS program is not ready");
      const references = playlist
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      const child = references.find((line) => line.endsWith("m3u8")) ?? references.at(-1);
      if (!child) throw conflict("OUTPUT_UNAVAILABLE", "The HLS program has no complete media");
      name = streamingObjectNameSchema.parse(child);
      if (depth === 2)
        throw conflict(
          "OUTPUT_UNAVAILABLE",
          "The HLS program exceeded the supported playlist depth",
        );
    }
    await database.transaction(async (db) => {
      const { run, job } = await leasedJob(db, request, config);
      const [currentSource] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, attachment.source.id));
      if (
        !config.broadcastsEnabled ||
        run.desiredState !== "running" ||
        job.desiredState !== "running" ||
        job.sourceSessionId !== attachment.source.id ||
        job.sourceGeneration !== attachment.source.generation ||
        currentSource?.state !== "live" ||
        currentSource.desiredState !== "running" ||
        currentSource.generation !== attachment.source.generation ||
        !currentSource.leasedUntil ||
        currentSource.leasedUntil.getTime() <= Date.now()
      )
        throw conflict("OUTPUT_CANCELLED", "The source attachment changed");
    });
    return {
      sourceSessionId: attachment.source.id,
      sourceGeneration: attachment.source.generation,
      bytesObserved: bytes,
    };
  });
  app.get("/internal/v1/broadcasts/media/:name", async (request, reply) => {
    const { name } = validate(z.object({ name: streamingObjectNameSchema }), request.params);
    const attachment = await database.transaction(async (db) => {
      const { run, job } = await leasedJob(db, request, config);
      if (
        !config.broadcastsEnabled ||
        run.desiredState !== "running" ||
        job.desiredState !== "running" ||
        !job.sourceSessionId ||
        job.sourceGeneration === null ||
        job.kind !== "rtmp"
      )
        throw conflict("OUTPUT_CANCELLED", "The output is being stopped.");
      const stream = await getStream(db, run.streamId);
      const [source] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, job.sourceSessionId));
      if (
        stream.status !== "active" ||
        source?.state !== "live" ||
        source.desiredState !== "running" ||
        source.generation !== job.sourceGeneration ||
        !source.leasedUntil ||
        source.leasedUntil.getTime() <= Date.now()
      )
        throw conflict("SOURCE_UNAVAILABLE", "The source is unavailable.");
      return { stream, source };
    });
    const body = await origin.media(
      attachment.stream,
      attachment.source,
      name,
      attachment.source.generation,
    );
    if (name.endsWith("m3u8")) {
      const playlist = body.toString();
      if (!playlist.startsWith("#EXTM3U") || playlist.includes("#EXT-X-KEY"))
        throw conflict("OUTPUT_UNAVAILABLE", "Unsupported output playlist.");
      for (const line of playlist.split(/\r?\n/u)) {
        if (line.trim() && !line.startsWith("#")) streamingObjectNameSchema.parse(line.trim());
        for (const match of line.matchAll(/URI="([^"]+)"/gu))
          streamingObjectNameSchema.parse(match[1]);
      }
    }
    await database.transaction(async (db) => {
      const { run, job } = await leasedJob(db, request, config);
      const [source] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, attachment.source.id));
      if (
        !config.broadcastsEnabled ||
        run.desiredState !== "running" ||
        job.desiredState !== "running" ||
        job.sourceSessionId !== attachment.source.id ||
        job.sourceGeneration !== attachment.source.generation ||
        source?.state !== "live" ||
        source.desiredState !== "running" ||
        source.generation !== attachment.source.generation ||
        !source.leasedUntil ||
        source.leasedUntil.getTime() <= Date.now()
      )
        throw conflict("OUTPUT_CANCELLED", "The output attachment changed.");
    });
    return reply
      .type(
        name.endsWith("m3u8")
          ? "application/vnd.apple.mpegurl"
          : name.endsWith("ts")
            ? "video/mp2t"
            : "video/mp4",
      )
      .send(body);
  });
  return Promise.resolve();
};
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing output worker ownership");
  return value;
}
