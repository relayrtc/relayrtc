import { schema } from "@relayrtc/database";
import { streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import type { RuntimeOptions } from "./runtime-routes.js";
import { equalSecret } from "./runtime-routes.js";
import { getStream, id, secret } from "./repository.js";
import { sourceSecret, sourceTransition, stopSourceSession } from "./restream-service.js";
import { ingestPath, StreamingGateway } from "./gateway.js";
const report = z
  .object({
    sequence: z.number().int().positive(),
    status: z.enum(["running", "ready", "failed", "stopped"]),
    fetchedBytes: z.number().int().min(0).max(20000000000),
    processingSeconds: z.number().min(0).max(86400),
    reason: z
      .enum(["SOURCE_PROFILE_UNSUPPORTED", "SOURCE_FETCH_FAILED", "SOURCE_PROCESSING_FAILED"])
      .optional(),
  })
  .strict();
export const restreamRuntimeRoutes: FastifyPluginAsync<
  Pick<RuntimeOptions, "database" | "config">
> = (app, { database, config }) => {
  app.post("/internal/v1/restream/claim", async (request) => {
    if (!equalSecret(request.headers.authorization ?? "", `Bearer ${config.workerKey}`))
      throw new ApiError(401, "INVALID_WORKER_KEY", "Worker authentication failed");
    validate(
      z.object({ workerId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u) }).strict(),
      request.body,
    );
    const [candidate] = await database
      .select()
      .from(schema.restreamSession)
      .where(
        sql`kind IN('probe','pull') AND desired_state='running' AND ended_at IS NULL AND leased_until IS NULL AND available_at<=now() AND deadline>now()`,
      )
      .orderBy(schema.restreamSession.availableAt)
      .limit(1);
    if (!candidate) return { job: null };
    return database.transaction(async (db) => {
      const [owner] = await db.execute(
        sql`SELECT t.id FROM streaming_stream t JOIN environment e ON e.id=t.environment_id JOIN project p ON p.id=t.project_id JOIN organization o ON o.id=t.organization_id WHERE t.id=${candidate.streamId} AND e.status='active' AND p.status='active' AND o.status='active' FOR SHARE OF e,p,o`,
      );
      if (!owner) return { job: null };
      const stream = await getStream(db, candidate.streamId, true),
        [source] = await db
          .select()
          .from(schema.restreamSource)
          .where(eq(schema.restreamSource.id, candidate.sourceId))
          .for("update");
      const [job] = await db
        .select()
        .from(schema.restreamSession)
        .where(eq(schema.restreamSession.id, candidate.id))
        .for("update");
      if (
        !source ||
        source.deletedAt ||
        stream.status !== "active" ||
        !job ||
        job.endedAt ||
        job.leasedUntil ||
        job.desiredState !== "running" ||
        job.deadline.getTime() <= Date.now()
      )
        return { job: null };
      if (job.attempts > source.reconnectBudget) {
        await stopSourceSession(db, source, "SOURCE_RETRY_EXHAUSTED");
        return { job: null };
      }
      if (job.kind === "pull") {
        const [publisher] = await db.execute(
          sql`SELECT id FROM streaming_session WHERE stream_id=${source.streamId} AND state NOT IN('ended','failed')`,
        );
        if (publisher) {
          await db
            .update(schema.restreamSession)
            .set({ availableAt: new Date(Date.now() + 2000) })
            .where(eq(schema.restreamSession.id, job.id));
          return { job: null };
        }
      }
      const value = secret(),
        credential = secret(),
        credentialId = id("ingest"),
        fence = job.fence + 1;
      let publishUrl: string | null = null;
      if (job.kind === "pull") {
        await new StreamingGateway(config).ensurePath(ingestPath(source.streamId));
        await db.execute(
          sql`INSERT INTO streaming_ingest_credential(id,stream_id,secret_hash,expires_at) VALUES(${credentialId},${source.streamId},${streamingSecretHash(credential)},now()+interval '15 seconds')`,
        );
        const url = new URL(
          `rtmp://${new URL(config.gatewayRtsp).hostname}:1935/${ingestPath(source.streamId)}`,
        );
        url.searchParams.set("pass", credential);
        publishUrl = url.href;
      }
      const details = sourceSecret(config, source);
      await db
        .update(schema.restreamSession)
        .set({
          leaseToken: streamingSecretHash(value),
          leasedUntil: new Date(Date.now() + 15000),
          attempts: job.attempts + 1,
          fence,
          sampleSequence: 0,
          attemptFetchedBytes: 0,
          attemptProcessingSeconds: 0,
          credentialId: job.kind === "pull" ? credentialId : null,
          state: job.kind === "probe" ? "probing" : "connecting",
        })
        .where(eq(schema.restreamSession.id, job.id));
      return {
        job: {
          id: job.id,
          kind: job.kind,
          token: value,
          endpoint: details.endpoint,
          authorization: details.authorization,
          allowedHosts: config.sourceAllowedHosts.filter(
            (host) =>
              host !== new URL(config.publicOrigin).hostname &&
              host !== new URL(config.publicRtmp).hostname,
          ),
          maxBytes: source.maxBytes - job.fetchedBytes,
          maxDurationSeconds: Math.max(1, Math.floor((job.deadline.getTime() - Date.now()) / 1000)),
          publishUrl,
        },
      };
    });
  });
  app.post("/internal/v1/restream/heartbeat", async (request) => {
    const token = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "",
      input = validate(report, request.body);
    const [candidate] = await database
      .select()
      .from(schema.restreamSession)
      .where(eq(schema.restreamSession.leaseToken, streamingSecretHash(token)));
    if (!candidate) throw new ApiError(409, "SOURCE_FENCED", "The source lease is no longer valid");
    return database.transaction(async (db) => {
      await db.execute(
        sql`SELECT t.id FROM streaming_stream t JOIN environment e ON e.id=t.environment_id JOIN project p ON p.id=t.project_id JOIN organization o ON o.id=t.organization_id WHERE t.id=${candidate.streamId} FOR SHARE OF e,p,o`,
      );
      const stream = await getStream(db, candidate.streamId, true),
        [source] = await db
          .select()
          .from(schema.restreamSource)
          .where(eq(schema.restreamSource.id, candidate.sourceId))
          .for("update"),
        [job] = await db
          .select()
          .from(schema.restreamSession)
          .where(eq(schema.restreamSession.id, candidate.id))
          .for("update");
      if (
        !source ||
        !job ||
        job.endedAt ||
        job.leaseToken !== streamingSecretHash(token) ||
        !job.leasedUntil ||
        job.leasedUntil.getTime() <= Date.now()
      )
        throw new ApiError(409, "SOURCE_FENCED", "The source lease is no longer valid");
      const stop =
        job.desiredState === "stopped" ||
        !!source.deletedAt ||
        stream.status !== "active" ||
        job.deadline.getTime() <= Date.now();
      if (input.sequence <= job.sampleSequence) return { stop };
      if (input.sequence !== job.sampleSequence + 1)
        throw new ApiError(409, "SOURCE_SEQUENCE_GAP", "Retry the previous observation first");
      const bytes = input.fetchedBytes - job.attemptFetchedBytes,
        seconds = input.processingSeconds - job.attemptProcessingSeconds;
      if (bytes < 0 || seconds < 0 || bytes > 134217728 || seconds > 20)
        throw new ApiError(
          400,
          "SOURCE_OBSERVATION_INVALID",
          "Source counters must be monotonic and bounded",
        );
      await db.execute(
        sql`INSERT INTO restream_usage(session_id,fence,sequence,fetched_bytes,processing_seconds) VALUES(${job.id},${job.fence},${input.sequence},${bytes},${seconds})`,
      );
      const [canonicalState] = await db.execute(
        sql`SELECT state FROM streaming_session WHERE ingress_credential_id=${job.credentialId} ORDER BY created_at DESC LIMIT 1`,
      );
      const limit = job.fetchedBytes + bytes >= source.maxBytes;
      const failed =
          input.status === "failed" ||
          limit ||
          canonicalState?.state === "failed" ||
          (job.kind === "pull" &&
            input.processingSeconds > 60 &&
            canonicalState?.state !== "live" &&
            source.state === "connecting"),
        done =
          input.status === "ready" ||
          input.status === "stopped" ||
          failed ||
          stop ||
          job.fetchedBytes + bytes >= source.maxBytes,
        retry =
          failed &&
          !stop &&
          !limit &&
          input.reason !== "SOURCE_PROFILE_UNSUPPORTED" &&
          job.attempts <= source.reconnectBudget;
      const reason = limit
        ? "SOURCE_BYTE_LIMIT"
        : canonicalState?.state === "failed"
          ? "SOURCE_CANONICAL_FAILED"
          : (input.reason ?? "SOURCE_PROCESSING_FAILED");
      let state: typeof source.state;
      if (done)
        state = retry
          ? "recovering"
          : failed
            ? "failed"
            : input.status === "ready"
              ? "ready"
              : "stopped";
      else {
        const [canonical] = await db.execute(
          sql`SELECT id FROM streaming_session WHERE ingress_credential_id=${job.credentialId} AND state='live' AND desired_state='running'`,
        );
        state =
          job.kind === "probe"
            ? "probing"
            : canonical
              ? "live"
              : source.state === "live" || source.state === "recovering"
                ? "recovering"
                : "connecting";
      }
      await db
        .update(schema.restreamSession)
        .set({
          sampleSequence: input.sequence,
          attemptFetchedBytes: input.fetchedBytes,
          attemptProcessingSeconds: input.processingSeconds,
          fetchedBytes: job.fetchedBytes + bytes,
          processingSeconds: job.processingSeconds + seconds,
          state,
          leasedUntil: done ? null : new Date(Date.now() + 15000),
          leaseToken: done ? null : job.leaseToken,
          endedAt: done && !retry ? new Date() : null,
          desiredState: done && !retry ? "stopped" : "running",
          availableAt: new Date(Date.now() + 5000),
          lastError: failed ? reason : null,
        })
        .where(eq(schema.restreamSession.id, job.id));
      if (done) {
        await stopSourceSession(db, source);
        if (retry)
          await db
            .update(schema.restreamSession)
            .set({ desiredState: "running" })
            .where(eq(schema.restreamSession.id, job.id));
      } else if (job.credentialId)
        await db.execute(
          sql`UPDATE streaming_ingest_credential SET expires_at=now()+interval '15 seconds' WHERE id=${job.credentialId} AND revoked_at IS NULL`,
        );
      if (!source.deletedAt)
        await sourceTransition(
          db,
          source,
          state as Parameters<typeof sourceTransition>[2],
          job.id,
          failed ? reason : null,
        );
      return { stop: stop || done };
    });
  });
  return Promise.resolve();
};
