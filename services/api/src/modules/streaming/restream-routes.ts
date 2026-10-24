import { requestBroadcastStop } from "./broadcast-service.js";
import { schema } from "@relayrtc/database";
import {
  createRestreamSourceSchema,
  updateRestreamSourceSchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { validateWebhookDestination } from "@relayrtc/protocol/webhook-security";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { recordAudit } from "@relayrtc/auth/server";
import { validate } from "../../http/validation/validate.js";
import { ApiError } from "../../http/errors/api-error.js";
import {
  authorize,
  conflict,
  getStream,
  id,
  idempotent,
  missing,
  type Transaction,
  type StreamRow,
} from "./repository.js";
import { destinationVault } from "./destinations.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";
import {
  publicSource,
  sourceContext,
  sourceDetail,
  sourceSecret,
  sourceTransition,
  stopSourceSession,
  type SourceRow,
} from "./restream-service.js";
const path = z.object({ sourceId: streamingIdSchema });
export const restreamRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const { database, config } = options,
    principal = registerStreamingManagementAuth(app, options);
  const scope = (request: FastifyRequest) => {
    const q = validate(streamScopeSchema, request.query),
      p = principal(request),
      projectId = q.projectId ?? (p.type === "key" ? p.key.projectId : undefined),
      environmentId = q.environmentId ?? (p.type === "key" ? p.key.environmentId : undefined);
    if (!projectId || !environmentId)
      throw new ApiError(400, "SCOPE_REQUIRED", "Select a project and environment");
    return { projectId, environmentId };
  };
  const command = (
    db: Transaction,
    request: FastifyRequest,
    payload: unknown,
    status: number,
    run: () => Promise<unknown>,
  ) => {
    const p = principal(request);
    return idempotent(
      db,
      `${p.type === "key" ? p.key.keyId : p.userId}:${request.method}:${request.url}`,
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : undefined,
      payload,
      status,
      run,
    );
  };
  const within = <T>(
    request: FastifyRequest,
    write: boolean,
    run: (
      db: Transaction,
      source: SourceRow,
      stream: StreamRow,
      auth: Awaited<ReturnType<typeof authorize>>,
    ) => Promise<T>,
  ) =>
    database.transaction(async (db) => {
      const { sourceId } = validate(path, request.params),
        [initial] = await db
          .select()
          .from(schema.restreamSource)
          .where(
            and(
              eq(schema.restreamSource.id, sourceId),
              request.method === "DELETE" ? undefined : isNull(schema.restreamSource.deletedAt),
            ),
          );
      if (!initial) throw missing();
      const q = validate(streamScopeSchema, request.query);
      if (
        (q.projectId && q.projectId !== initial.projectId) ||
        (q.environmentId && q.environmentId !== initial.environmentId)
      )
        throw missing();
      const auth = await authorize(
          db,
          principal(request),
          initial,
          write ? "streams:write" : "streams:read",
        ),
        stream = await getStream(db, initial.streamId, write);
      if (stream.status !== "active") throw missing();
      const query = db
        .select()
        .from(schema.restreamSource)
        .where(
          and(
            eq(schema.restreamSource.id, sourceId),
            request.method === "DELETE" ? undefined : isNull(schema.restreamSource.deletedAt),
          ),
        );
      const [source] = await (write ? query.for("update") : query);
      if (!source) throw missing();
      return run(db, source, stream, auth);
    });
  const checkEndpoint = async (endpoint: string) => {
    try {
      const u = new URL(endpoint);
      if (
        !config.sourceAllowedHosts.includes(u.hostname.toLowerCase()) ||
        ![80, 443].includes(Number(u.port || (u.protocol === "https:" ? 443 : 80))) ||
        u.hostname === new URL(config.publicOrigin).hostname
      )
        throw new Error();
      return (await validateWebhookDestination(endpoint)).hostname;
    } catch {
      throw new ApiError(
        400,
        "SOURCE_ADDRESS_REJECTED",
        "Use a public HTTP(S) source on an explicitly allowed host and port 80 or 443.",
      );
    }
  };
  const audit = async (
    db: Transaction,
    stream: StreamRow,
    actor: Awaited<ReturnType<typeof authorize>>["actor"],
    action: string,
    sourceId: string,
    correlationId: string,
  ) =>
    recordAudit(db, {
      actor,
      action,
      outcome: "SUCCESS",
      organizationId: stream.organizationId,
      resourceType: "restream_source",
      resourceId: sourceId,
      correlationId,
    });
  app.get("/restream-sources", (request) =>
    database.transaction(async (db) => {
      const s = scope(request),
        q = validate(
          streamScopeSchema
            .extend({
              cursor: streamingIdSchema.optional(),
              streamId: streamingIdSchema.optional(),
              limit: z.coerce.number().int().min(1).max(100).default(30),
            })
            .strict(),
          request.query,
        );
      await authorize(db, principal(request), s, "streams:read");
      const rows = await db
        .select()
        .from(schema.restreamSource)
        .where(
          and(
            eq(schema.restreamSource.projectId, s.projectId),
            eq(schema.restreamSource.environmentId, s.environmentId),
            q.streamId ? eq(schema.restreamSource.streamId, q.streamId) : undefined,
            request.method === "DELETE" ? undefined : isNull(schema.restreamSource.deletedAt),
            q.cursor ? gt(schema.restreamSource.id, q.cursor) : undefined,
          ),
        )
        .orderBy(schema.restreamSource.id)
        .limit(q.limit + 1);
      return {
        data: rows.slice(0, q.limit).map(publicSource),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]?.id : null,
      };
    }),
  );
  app.get("/restream-sources/:sourceId", (request) =>
    within(request, false, (db, source) => sourceDetail(db, source)),
  );
  app.post("/restream-sources", async (request, reply) => {
    const input = validate(createRestreamSourceSchema, request.body),
      s = scope(request);
    const result = await database.transaction(async (db) => {
      const auth = await authorize(db, principal(request), s, "streams:write"),
        stream = await getStream(db, input.streamId, true);
      if (
        stream.status !== "active" ||
        stream.projectId !== s.projectId ||
        stream.environmentId !== s.environmentId
      )
        throw missing();
      if (stream.source.kind !== (input.protocol === "whip_push" ? "whip" : "rtmp"))
        throw conflict(
          "SOURCE_ATTACHMENT_INVALID",
          "Attach HLS pull or RTMP push to an RTMP stream, and WHIP push to a WHIP stream.",
        );
      return command(db, request, input, 201, async () => {
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${s.environmentId},5))`);
        const [count] = await db.execute(
          sql`SELECT count(*)::int n FROM restream_source WHERE environment_id=${s.environmentId} AND deleted_at IS NULL`,
        );
        if (Number(count?.n) >= 100)
          throw conflict("SOURCE_REGISTRY_LIMIT", "The environment source limit is 100.");
        const sourceId = id("restream"),
          host = input.endpoint ? await checkEndpoint(input.endpoint) : null;
        const [row] = await db
          .insert(schema.restreamSource)
          .values({
            id: sourceId,
            streamId: stream.id,
            ...s,
            name: input.name,
            protocol: input.protocol,
            host,
            encryptedSecret: input.endpoint
              ? destinationVault(config).encrypt(
                  JSON.stringify({
                    endpoint: input.endpoint,
                    authorization: input.authorization ?? "",
                  }),
                  sourceContext({ id: sourceId, version: 1 }),
                )
              : null,
            reconnectBudget: input.reconnectBudget,
            maxDurationSeconds: Math.min(input.maxDurationSeconds, stream.maxDurationSeconds),
            maxBytes: input.maxBytes,
          })
          .returning();
        if (!row) throw missing();
        await audit(db, stream, auth.actor, "restream.created", row.id, request.id);
        return publicSource(row);
      });
    });
    return reply.code(201).send(result);
  });
  app.patch("/restream-sources/:sourceId", (request) => {
    const input = validate(updateRestreamSourceSchema, request.body);
    return within(request, true, (db, source, stream, auth) =>
      command(db, request, input, 200, async () => {
        if (input.version !== source.version)
          throw conflict("SOURCE_VERSION_CONFLICT", "Refresh the source before editing.");
        const [active] = await db.execute(
          sql`SELECT id FROM restream_session WHERE source_id=${source.id} AND ended_at IS NULL`,
        );
        if (active)
          throw conflict(
            "SOURCE_BUSY",
            "Stop the source and wait for it to finish before editing.",
          );
        if (
          source.protocol !== "hls_pull" &&
          (input.endpoint !== undefined || input.authorization !== undefined)
        )
          throw conflict("SOURCE_PROTOCOL_INVALID", "Push sources use stream ingest credentials.");
        let encryptedSecret = source.encryptedSecret,
          host = source.host;
        if (source.protocol === "hls_pull") {
          const old = sourceSecret(config, source),
            endpoint = input.endpoint ?? old.endpoint;
          host = await checkEndpoint(endpoint);
          encryptedSecret = destinationVault(config).encrypt(
            JSON.stringify({ endpoint, authorization: input.authorization ?? old.authorization }),
            sourceContext({ id: source.id, version: source.version + 1 }),
          );
        }
        const [row] = await db
          .update(schema.restreamSource)
          .set({
            name: input.name ?? source.name,
            reconnectBudget: input.reconnectBudget ?? source.reconnectBudget,
            maxDurationSeconds: Math.min(
              input.maxDurationSeconds ?? source.maxDurationSeconds,
              stream.maxDurationSeconds,
            ),
            maxBytes: input.maxBytes ?? source.maxBytes,
            host,
            encryptedSecret,
            version: source.version + 1,
            state: "created",
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.restreamSource.id, source.id))
          .returning();
        if (!row) throw missing();
        await audit(db, stream, auth.actor, "restream.updated", source.id, request.id);
        return publicSource(row);
      }),
    );
  });
  for (const action of ["probe", "start", "stop", "delete"] as const) {
    const handler = async (request: FastifyRequest) =>
      within(request, true, (db, source, stream, auth) =>
        command(db, request, {}, action === "probe" || action === "start" ? 202 : 200, async () => {
          validate(z.object({}).strict(), request.body ?? {});
          if (action === "delete" && source.deletedAt) return { id: source.id, deleted: true };
          if (action === "stop" || action === "delete") {
            await stopSourceSession(db, source);
            if (action === "delete") {
              await sourceTransition(db, source, "stopped", null, "SOURCE_DELETED");
              const runs = await db
                .select()
                .from(schema.broadcastRun)
                .where(
                  sql`stream_id=${stream.id} AND state NOT IN('stopped','failed') AND EXISTS(SELECT 1 FROM restream_session r WHERE r.source_id=${source.id} AND r.kind<>'probe' AND r.ended_at IS NULL)`,
                )
                .orderBy(schema.broadcastRun.id)
                .for("update");
              for (const run of runs) await requestBroadcastStop(db, run, "SOURCE_DELETED");
              await db
                .update(schema.restreamSource)
                .set({
                  deletedAt: new Date(),
                  encryptedSecret: null,
                  state: "stopped",
                  updatedAt: new Date(),
                })
                .where(eq(schema.restreamSource.id, source.id));
            }
            await audit(db, stream, auth.actor, `restream.${action}`, source.id, request.id);
            return action === "delete"
              ? { id: source.id, deleted: true }
              : sourceDetail(db, source);
          }
          if (action === "start")
            await authorize(db, principal(request), source, "streams:publish");
          const [active] = await db
            .select()
            .from(schema.restreamSession)
            .where(sql`source_id=${source.id} AND ended_at IS NULL`);
          if (active) {
            if (active.desiredState !== "running")
              throw conflict("SOURCE_BUSY", "Wait for the previous source to finish stopping");
            if ((action === "probe") !== (active.kind === "probe"))
              throw conflict("SOURCE_BUSY", "A different source operation is active.");
            return sourceDetail(db, source);
          }
          if (action === "probe" && source.protocol !== "hls_pull") {
            await sourceTransition(db, source, "ready", null);
            return sourceDetail(db, { ...source, state: "ready", lastError: null });
          }
          if (source.protocol === "hls_pull")
            await checkEndpoint(sourceSecret(config, source).endpoint);
          await db.execute(sql`SELECT pg_advisory_xact_lock(810035)`);
          const [count] = await db.execute(
            sql`SELECT count(*)::int n FROM restream_session WHERE ended_at IS NULL`,
          );
          if (Number(count?.n) >= config.maxSourceJobs)
            throw conflict("SOURCE_CAPACITY", "External source capacity is full.");
          if (action === "start") {
            const [occupied] = await db.execute(
              sql`SELECT id FROM restream_session WHERE stream_id=${source.streamId} AND kind<>'probe' AND ended_at IS NULL`,
            );
            if (occupied)
              throw conflict("PUBLISHER_CONFLICT", "Another registered source owns this stream");
          }
          const [publisher] = await db.execute(
            sql`SELECT id FROM streaming_session WHERE stream_id=${source.streamId} AND state NOT IN('ended','failed')`,
          );
          if (action === "start" && source.protocol === "hls_pull" && publisher)
            throw conflict(
              "PUBLISHER_CONFLICT",
              "Stop the current publisher before pulling this source.",
            );
          const jobId = id("restream_session"),
            kind = action === "probe" ? "probe" : source.protocol === "hls_pull" ? "pull" : "push",
            state = action === "probe" ? "probing" : "connecting";
          await db.insert(schema.restreamSession).values({
            id: jobId,
            sourceId: source.id,
            streamId: source.streamId,
            kind,
            state,
            deadline: new Date(
              Date.now() +
                (kind === "probe"
                  ? 60
                  : Math.min(source.maxDurationSeconds, stream.maxDurationSeconds)) *
                  1000,
            ),
          });
          await sourceTransition(db, source, state, jobId);
          await audit(db, stream, auth.actor, `restream.${action}`, source.id, request.id);
          return sourceDetail(db, { ...source, state, lastError: null });
        }),
      );
    if (action === "delete") app.delete("/restream-sources/:sourceId", handler);
    else
      app.post(`/restream-sources/:sourceId/${action}`, async (request, reply) =>
        reply.code(action === "stop" ? 200 : 202).send(await handler(request)),
      );
  }
  return Promise.resolve();
};
