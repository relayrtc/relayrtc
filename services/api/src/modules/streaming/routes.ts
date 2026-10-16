import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { signStreamingGrant, streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import {
  createStreamSchema,
  updateStreamSchema,
  listStreamsSchema,
  streamScopeSchema,
  streamingIdSchema,
  ingestCredentialSchema,
  playbackGrantSchema,
} from "@relayrtc/validation";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateApiKey } from "../../authentication/api-key-authenticator.js";
import { assertClaimedScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import type { ConsoleSessionVerifier } from "../reporting/reporting.routes.js";
import type { StreamingConfig } from "./config.js";
import {
  audit,
  authorize,
  conflict,
  event,
  getStream,
  id,
  idempotent,
  missing,
  operation,
  publicSession,
  publicStream,
  secret,
  type Principal,
  type Scope,
  type Transaction,
  type StreamRow,
} from "./repository.js";
import { startSession, stopSessions } from "./lifecycle.js";
import { StreamingGateway, ingestPath } from "./gateway.js";

export interface StreamingRoutesOptions {
  database: RelayKitDatabase;
  config: StreamingConfig;
  verifyConsoleSession?: ConsoleSessionVerifier;
  consoleOrigin?: string;
}
const paramsSchema = z.object({
  streamId: streamingIdSchema.optional(),
  operationId: streamingIdSchema.optional(),
  credentialId: streamingIdSchema.optional(),
});
const noBody = z.object({}).strict();
export const streamingRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const { database, config } = options;
  const principals = new WeakMap<FastifyRequest, Principal>();
  app.decorateRequest("apiKey", null);
  app.decorateRequest("webhookPrincipal", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (request.headers.authorization !== undefined) {
      const token = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization)?.[1];
      const key = token ? await authenticateApiKey(database, token) : null;
      if (!key) throw new ApiError(401, "INVALID_API_KEY", "Provide a valid secret API key");
      assertClaimedScope(request, key);
      request.apiKey = key;
      principals.set(request, { type: "key", key });
    } else {
      const headers = new Headers();
      if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
      const session = await options.verifyConsoleSession?.(headers);
      if (!session)
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide an API key or console session");
      if (
        !["GET", "HEAD"].includes(request.method) &&
        (!options.consoleOrigin || request.headers.origin !== options.consoleOrigin)
      )
        throw new ApiError(403, "ORIGIN_REQUIRED", "A trusted console Origin is required");
      principals.set(request, { type: "user", userId: session.userId });
      // The shared administrative audit hook uses this existing session context.
      request.webhookPrincipal = { type: "session", userId: session.userId };
    }
  });
  const principal = (request: FastifyRequest) => required(principals.get(request));
  const actorKey = (request: FastifyRequest) => {
    const p = principal(request);
    return p.type === "key" ? p.key.keyId : p.userId;
  };
  const command = (
    db: Transaction,
    request: FastifyRequest,
    status: number,
    payload: unknown,
    run: () => Promise<unknown>,
  ) =>
    idempotent(
      db,
      `${actorKey(request)}:${request.method}:${request.url}`,
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : undefined,
      payload,
      status,
      run,
    );
  const scopeFor = (request: FastifyRequest): Scope => {
    const query = validate(streamScopeSchema, request.query),
      p = principal(request);
    const projectId = query.projectId ?? (p.type === "key" ? p.key.projectId : undefined);
    const environmentId =
      query.environmentId ?? (p.type === "key" ? p.key.environmentId : undefined);
    if (!projectId || !environmentId)
      throw new ApiError(400, "SCOPE_REQUIRED", "Select a project and environment");
    return { projectId, environmentId };
  };
  const withStream = <T>(
    request: FastifyRequest,
    permission: string,
    run: (
      db: Transaction,
      stream: StreamRow,
      auth: Awaited<ReturnType<typeof authorize>>,
    ) => Promise<T>,
  ) =>
    database.transaction(async (db) => {
      const { streamId } = validate(paramsSchema, request.params);
      if (!streamId) throw missing();
      const initial = await getStream(db, streamId);
      const query = validate(streamScopeSchema, request.query);
      if (
        (query.projectId && query.projectId !== initial.projectId) ||
        (query.environmentId && query.environmentId !== initial.environmentId)
      )
        throw missing();
      const auth = await authorize(db, principal(request), initial, permission);
      const stream = await getStream(db, streamId, permission !== "streams:read");
      return run(db, stream, auth);
    });
  app.get("/streams", async (request) =>
    database.transaction(async (db) => {
      const scope = scopeFor(request),
        query = validate(listStreamsSchema, request.query);
      await authorize(db, principal(request), scope, "streams:read");
      const rows = await db
        .select()
        .from(schema.streamingStream)
        .where(
          and(
            eq(schema.streamingStream.projectId, scope.projectId),
            eq(schema.streamingStream.environmentId, scope.environmentId),
            query.cursor ? gt(schema.streamingStream.id, query.cursor) : undefined,
          ),
        )
        .orderBy(schema.streamingStream.id)
        .limit(query.limit + 1);
      return {
        data: rows.slice(0, query.limit).map(publicStream),
        nextCursor: rows.length > query.limit ? required(rows[query.limit - 1]).id : null,
      };
    }),
  );
  app.post("/streams", async (request, reply) => {
    const input = validate(createStreamSchema, request.body),
      scope = scopeFor(request);
    const result = await database.transaction(async (db) => {
      const auth = await authorize(db, principal(request), scope, "streams:write");
      return command(db, request, 201, { ...scope, input }, async () => {
        await db.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.environmentId},1))`,
        );
        const [count] = await db.execute(
          sql`SELECT count(*)::int AS value FROM streaming_stream WHERE environment_id=${scope.environmentId} AND status<>'deleted'`,
        );
        if (Number(count?.value) >= config.maxStreamsPerEnvironment)
          throw new ApiError(429, "STREAM_LIMIT", "This environment has reached its stream limit");
        if (input.source.kind === "room") {
          const [room] = await db.execute(
            sql`SELECT id FROM room WHERE id=${input.source.roomId} AND project_id=${scope.projectId} AND environment_id=${scope.environmentId} AND status IN ('created','active') FOR SHARE`,
          );
          if (!room) throw missing();
        }
        const [stream] = await db
          .insert(schema.streamingStream)
          .values({ ...input, ...scope, organizationId: auth.organizationId, id: id("stream") })
          .returning();
        await event(db, required(stream), "stream.created", null, request.id);
        await audit(db, required(stream), auth.actor, "stream.created", request.id);
        return publicStream(required(stream));
      });
    });
    return reply.code(201).send(result);
  });
  app.get("/streams/:streamId", (request) =>
    withStream(request, "streams:read", async (db, stream) => {
      const sessions = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.streamId, stream.id))
        .orderBy(sql`${schema.streamingSession.createdAt} DESC`)
        .limit(10);
      return { ...publicStream(stream), sessions: sessions.map(publicSession) };
    }),
  );
  app.patch("/streams/:streamId", (request) =>
    withStream(request, "streams:write", async (db, stream, auth) => {
      const { version, ...change } = validate(updateStreamSchema, request.body);
      if (stream.status !== "active" || version !== stream.version)
        throw conflict(
          "STREAM_VERSION_CONFLICT",
          "Reload the current stream configuration before updating",
        );
      const [active] = await db.execute(
        sql`SELECT id FROM streaming_session WHERE stream_id=${stream.id} AND state NOT IN ('ended','failed')`,
      );
      if (active)
        throw conflict("STREAM_RUNNING", "Stop the source session before changing configuration");
      if (change.source?.kind === "room") {
        const [room] = await db.execute(
          sql`SELECT id FROM room WHERE id=${change.source.roomId} AND project_id=${stream.projectId} AND environment_id=${stream.environmentId} AND status IN ('created','active') FOR SHARE`,
        );
        if (!room) throw missing();
      }
      const [updated] = await db
        .update(schema.streamingStream)
        .set({
          ...change,
          version: version + 1,
          playbackEpoch: stream.playbackEpoch + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.streamingStream.id, stream.id))
        .returning();
      await audit(db, stream, auth.actor, "stream.updated", request.id);
      return publicStream(required(updated));
    }),
  );
  app.post("/streams/:streamId/source-sessions", async (request, reply) => {
    validate(noBody, request.body ?? {});
    const result = await withStream(request, "streams:publish", (db, stream, auth) =>
      command(db, request, 202, {}, async () => {
        if (stream.source.kind !== "room")
          throw conflict(
            "INGEST_ADMISSION_REQUIRED",
            "WHIP and RTMP sessions start when the publisher connects",
          );
        const session = await startSession(db, stream, config);
        await audit(db, stream, auth.actor, "stream.start.requested", request.id);
        return operation(db, stream.id, "start", session.id);
      }),
    );
    return reply.code(202).send(result);
  });
  for (const kind of ["stop", "delete"] as const) {
    app.route({
      method: kind === "stop" ? "POST" : "DELETE",
      url: kind === "stop" ? "/streams/:streamId/stop" : "/streams/:streamId",
      handler: async (request, reply) => {
        validate(noBody, request.body ?? {});
        const result = await withStream(request, "streams:write", (db, stream, auth) =>
          command(db, request, 202, {}, async () => {
            const stoppedSessionId = await stopSessions(db, stream.id);
            await db.execute(
              sql`UPDATE streaming_stream SET playback_epoch=playback_epoch+1,version=version+1,updated_at=now(),status=${kind === "delete" ? "deleting" : stream.status} WHERE id=${stream.id}`,
            );
            if (kind === "delete")
              await db.execute(
                sql`UPDATE streaming_ingest_credential SET revoked_at=now() WHERE stream_id=${stream.id} AND revoked_at IS NULL`,
              );
            await audit(db, stream, auth.actor, `stream.${kind}.requested`, request.id);
            return operation(db, stream.id, kind, kind === "stop" ? stoppedSessionId : null);
          }),
        );
        return reply.code(202).send(result);
      },
    });
  }
  const vaultKey = createHash("sha256")
    .update(config.secret)
    .update("streaming-idempotency")
    .digest();
  const seal = (value: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", vaultKey, iv);
    return Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64url");
  };
  const open = (value: string) => {
    const bytes = Buffer.from(value, "base64url"),
      cipher = createDecipheriv("aes-256-gcm", vaultKey, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8");
  };
  for (const rotate of [false, true])
    app.post(
      rotate
        ? "/streams/:streamId/ingest-credentials/:credentialId/rotate"
        : "/streams/:streamId/ingest-credentials",
      async (request, reply) => {
        const input = validate(ingestCredentialSchema, request.body ?? {});
        const result = (await withStream(request, "streams:publish", (db, stream, auth) =>
          command(db, request, 201, input, async () => {
            if (stream.status !== "active" || stream.source.kind === "room")
              throw conflict(
                "INGEST_NOT_AVAILABLE",
                "This stream does not accept external publishers",
              );
            const { credentialId } = validate(paramsSchema, request.params);
            if (rotate) {
              const [old] = await db.execute(
                sql`UPDATE streaming_ingest_credential SET revoked_at=now() WHERE id=${required(credentialId)} AND stream_id=${stream.id} RETURNING id`,
              );
              if (!old) throw missing();
              await stopSessions(db, stream.id);
            }
            const [count] = await db.execute(
              sql`SELECT count(*)::int AS n FROM streaming_ingest_credential WHERE stream_id=${stream.id} AND revoked_at IS NULL AND expires_at>now()`,
            );
            if (Number(count?.n) >= 5)
              throw conflict(
                "INGEST_CREDENTIAL_LIMIT",
                "Rotate an existing credential before issuing another",
              );
            const value = secret(),
              credential = id("ingest"),
              expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
            await new StreamingGateway(config).ensurePath(ingestPath(stream.id));
            await db.execute(
              sql`INSERT INTO streaming_ingest_credential(id,stream_id,secret_hash,expires_at) VALUES(${credential},${stream.id},${streamingSecretHash(value)},${expiresAt})`,
            );
            await audit(
              db,
              stream,
              auth.actor,
              rotate ? "stream.ingest.rotated" : "stream.ingest.created",
              request.id,
            );
            return {
              id: credential,
              expiresAt,
              encryptedSecret: seal(value),
              protocol: stream.source.kind,
              url:
                stream.source.kind === "whip"
                  ? `${config.publicOrigin}/v1/ingest/whip/${stream.id}`
                  : `${config.publicRtmp.replace(/\/$/u, "")}/ingest_${stream.id}`,
            };
          }),
        )) as { encryptedSecret: string; [key: string]: unknown };
        const { encryptedSecret, ...rest } = result;
        return reply.code(201).send({ ...rest, secret: open(encryptedSecret) });
      },
    );
  app.post("/streams/:streamId/playback-grants", (request) =>
    withStream(request, "streams:playback", async (db, stream, auth) => {
      const input = validate(playbackGrantSchema, request.body ?? {});
      const [session] = await db
        .select()
        .from(schema.streamingSession)
        .where(
          and(
            eq(schema.streamingSession.streamId, stream.id),
            eq(schema.streamingSession.desiredState, "running"),
          ),
        )
        .orderBy(sql`${schema.streamingSession.createdAt} DESC`)
        .limit(1);
      if (stream.status !== "active" || !session || ["ended", "failed"].includes(session.state))
        throw conflict("SOURCE_UNAVAILABLE", "Start a source session before granting playback");
      const token = signStreamingGrant(
        config.secret,
        {
          aud: "streaming-playback",
          sub: id("viewer"),
          streamId: stream.id,
          sessionId: session.id,
          action: "read",
          generation: stream.playbackEpoch,
        },
        input.ttlSeconds,
      );
      await audit(db, stream, auth.actor, "stream.playback.granted", request.id);
      return {
        token,
        expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
        url: `${config.publicOrigin}/v1/playback/${stream.id}/${session.id}/index.m3u8?token=${encodeURIComponent(token)}`,
      };
    }),
  );
  app.post("/streams/:streamId/playback-grants/revoke", (request) =>
    withStream(request, "streams:playback", async (db, stream, auth) => {
      validate(noBody, request.body ?? {});
      await db.execute(
        sql`UPDATE streaming_stream SET playback_epoch=playback_epoch+1 WHERE id=${stream.id}`,
      );
      await audit(db, stream, auth.actor, "stream.playback.revoked", request.id);
      return { revoked: true };
    }),
  );
  app.get("/streams/:streamId/playback", (request) =>
    withStream(request, "streams:read", async (db, stream) => {
      const [session] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.streamId, stream.id))
        .orderBy(sql`${schema.streamingSession.createdAt} DESC`)
        .limit(1);
      return {
        streamId: stream.id,
        sourceSessionId: session?.id ?? null,
        generation: session?.generation ?? null,
        state: session?.state ?? "ready",
        profile: stream.profile,
        protocols: ["hls", "ll-hls"],
        grantRequired: true,
        grantTtlSeconds: 300,
        renewal: "POST /v1/streams/{streamId}/playback-grants",
        delivery: "single-rendition-fmp4",
        latencyTargetSeconds: null,
      };
    }),
  );
  app.get("/streams/:streamId/usage", (request) =>
    withStream(request, "streams:read", async (db, stream) => {
      const [row] =
        await db.execute(sql`SELECT coalesce(sum(source_seconds),0)::float8 AS "sourceSeconds",coalesce(sum(ingress_bytes),0)::float8 AS "ingressBytes",coalesce(sum(program_bytes),0)::float8 AS "programBytes",count(*)::int AS samples,
      CASE WHEN count(*)=0 OR bool_or(coverage='partial') THEN 'partial' ELSE 'observed' END AS coverage FROM streaming_usage_sample WHERE stream_id=${stream.id}`);
      return { streamId: stream.id, ...row };
    }),
  );
  app.get("/streaming-operations/:operationId", (request) =>
    database.transaction(async (db) => {
      const { operationId } = validate(paramsSchema, request.params);
      const [op] = await db
        .select()
        .from(schema.streamingOperation)
        .where(eq(schema.streamingOperation.id, required(operationId)));
      if (!op) throw missing();
      const stream = await getStream(db, op.streamId);
      await authorize(db, principal(request), stream, "streams:read");
      return op;
    }),
  );
  return Promise.resolve();
};

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
