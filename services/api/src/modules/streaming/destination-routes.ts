import { schema } from "@relayrtc/database";
import {
  createDestinationSchema,
  updateDestinationSchema,
  rotateDestinationSecretSchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { validate } from "../../http/validation/validate.js";
import { ApiError } from "../../http/errors/api-error.js";
import {
  authorize,
  getStream,
  id,
  idempotent,
  missing,
  conflict,
  type Transaction,
} from "./repository.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";
import {
  checkDestination,
  destinationAudit,
  destinationContext,
  destinationEvent,
  destinationVault,
  publicDestination,
} from "./destinations.js";

const params = z.object({
  streamId: streamingIdSchema,
  destinationId: streamingIdSchema.optional(),
});
const listQuery = streamScopeSchema
  .extend({
    cursor: streamingIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const destinationRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const principal = registerStreamingManagementAuth(app, options),
    { database, config } = options;
  const within = <T>(
    request: FastifyRequest,
    write: boolean,
    action: (
      db: Transaction,
      stream: Awaited<ReturnType<typeof getStream>>,
      actor: Awaited<ReturnType<typeof authorize>>["actor"],
    ) => Promise<T>,
  ) =>
    database.transaction(async (db) => {
      const path = validate(params, request.params),
        claimed = validate(streamScopeSchema, request.query);
      const initial = await getStream(db, path.streamId);
      if (
        (claimed.projectId && claimed.projectId !== initial.projectId) ||
        (claimed.environmentId && claimed.environmentId !== initial.environmentId)
      )
        throw missing();
      const auth = await authorize(
        db,
        principal(request),
        initial,
        write ? "streams:write" : "streams:read",
      );
      const stream = await getStream(db, initial.id, write);
      if (stream.status !== "active") throw missing();
      return action(db, stream, auth.actor);
    });
  const command = (
    db: Transaction,
    request: FastifyRequest,
    payload: unknown,
    status: number,
    run: () => Promise<unknown>,
  ) => {
    const actor = principal(request);
    return idempotent(
      db,
      `${actor.type === "key" ? actor.key.keyId : actor.userId}:${request.method}:${request.url}`,
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : undefined,
      payload,
      status,
      run,
    );
  };
  const get = async (db: Transaction, streamId: string, request: FastifyRequest) => {
    const destinationId = validate(params, request.params).destinationId;
    const [row] = await db
      .select()
      .from(schema.streamDestination)
      .where(
        and(
          eq(schema.streamDestination.id, destinationId ?? ""),
          eq(schema.streamDestination.streamId, streamId),
          isNull(schema.streamDestination.deletedAt),
        ),
      )
      .for("update");
    if (!row) throw missing();
    return row;
  };
  app.get("/streams/:streamId/destinations", (request) =>
    within(request, false, async (db, stream) => {
      const query = validate(listQuery, request.query);
      const rows = await db
        .select()
        .from(schema.streamDestination)
        .where(
          and(
            eq(schema.streamDestination.streamId, stream.id),
            isNull(schema.streamDestination.deletedAt),
            query.cursor ? gt(schema.streamDestination.id, query.cursor) : undefined,
          ),
        )
        .orderBy(schema.streamDestination.id)
        .limit(query.limit + 1);
      return {
        data: rows.slice(0, query.limit).map(publicDestination),
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.id : null,
      };
    }),
  );
  app.get("/streams/:streamId/destinations/:destinationId", (request) =>
    within(request, false, async (db, stream) =>
      publicDestination(await get(db, stream.id, request)),
    ),
  );
  app.post("/streams/:streamId/destinations", async (request, reply) => {
    const input = validate(createDestinationSchema, request.body);
    const result = await within(request, true, (db, stream, actor) =>
      command(db, request, input, 201, async () => {
        const [counts] = await db.execute(
          sql`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total, count(*) FILTER (WHERE created_at>now()-interval '1 minute')::int AS recent FROM stream_destination WHERE stream_id=${stream.id}`,
        );
        if (Number(counts?.total) >= config.maxDestinations)
          throw conflict("DESTINATION_LIMIT", "The stream destination limit has been reached.");
        if (Number(counts?.recent) >= 10)
          throw new ApiError(
            429,
            "DESTINATION_RATE_LIMIT",
            "Wait before adding more destinations.",
          );
        const target = await checkDestination(input.endpoint),
          destinationId = id("destination");
        const [row] = await db
          .insert(schema.streamDestination)
          .values({
            id: destinationId,
            streamId: stream.id,
            name: input.name,
            host: target.hostname,
            protocol: target.secure ? "rtmps" : "rtmp",
            port: target.port,
            profile: input.profile,
            enabled: input.enabled,
            encryptedSecret: destinationVault(config).encrypt(
              JSON.stringify({ endpoint: input.endpoint, streamKey: input.streamKey }),
              destinationContext(destinationId, 1),
            ),
          })
          .returning();
        if (!row) throw missing();
        await destinationAudit(db, stream, actor, "destination.created", row.id, request.id);
        await destinationEvent(db, { ...stream, streamId: stream.id }, "destination.created", {
          destinationId: row.id,
          correlationId: request.id,
        });
        return publicDestination(row);
      }),
    );
    return reply.code(201).send(result);
  });
  const mutate = (rotate: boolean) => async (request: FastifyRequest) => {
    const input = rotate
      ? validate(rotateDestinationSecretSchema, request.body)
      : validate(updateDestinationSchema, request.body);
    return within(request, true, (db, stream, actor) =>
      command(db, request, input, 200, async () => {
        const current = await get(db, stream.id, request);
        if (input.version !== current.version)
          throw conflict(
            "DESTINATION_VERSION_CONFLICT",
            "Reload the destination before changing it.",
          );
        const vault = destinationVault(config);
        const secret = z
          .object({ endpoint: z.string(), streamKey: z.string() })
          .parse(
            JSON.parse(
              vault.decrypt(
                current.encryptedSecret ?? "",
                destinationContext(current.id, current.credentialVersion),
              ),
            ),
          );
        const endpoint =
          "endpoint" in input && typeof input.endpoint === "string"
            ? input.endpoint
            : secret.endpoint;
        const target = await checkDestination(endpoint),
          version = current.credentialVersion + 1;
        const [row] = await db
          .update(schema.streamDestination)
          .set({
            ...("name" in input && typeof input.name === "string" ? { name: input.name } : {}),
            ...("profile" in input && input.profile ? { profile: input.profile } : {}),
            ...("enabled" in input && typeof input.enabled === "boolean"
              ? { enabled: input.enabled }
              : {}),
            host: target.hostname,
            protocol: target.secure ? "rtmps" : "rtmp",
            port: target.port,
            version: current.version + 1,
            credentialVersion: version,
            updatedAt: new Date(),
            encryptedSecret: vault.encrypt(
              JSON.stringify({
                endpoint,
                streamKey: "streamKey" in input ? input.streamKey : secret.streamKey,
              }),
              destinationContext(current.id, version),
            ),
          })
          .where(eq(schema.streamDestination.id, current.id))
          .returning();
        if (!row) throw missing();
        await destinationAudit(
          db,
          stream,
          actor,
          rotate ? "destination.secret.rotated" : "destination.updated",
          row.id,
          request.id,
        );
        return publicDestination(row);
      }),
    );
  };
  app.patch("/streams/:streamId/destinations/:destinationId", mutate(false));
  app.post("/streams/:streamId/destinations/:destinationId/rotate-secret", mutate(true));
  app.delete("/streams/:streamId/destinations/:destinationId", (request) =>
    within(request, true, (db, stream, actor) =>
      command(db, request, {}, 200, async () => {
        const row = await get(db, stream.id, request);
        await db
          .update(schema.streamDestination)
          .set({
            deletedAt: new Date(),
            enabled: false,
            encryptedSecret: null,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.streamDestination.id, row.id));
        await destinationAudit(db, stream, actor, "destination.deleted", row.id, request.id);
        return { id: row.id, deleted: true };
      }),
    ),
  );
  return Promise.resolve();
};
