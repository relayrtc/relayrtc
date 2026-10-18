import { dvrOpenApi } from "./dvr-openapi.js";
import { recordAudit } from "@relayrtc/auth/server";
import {
  configureDvrSchema,
  updateDvrSchema,
  dvrPolicySchema,
  dvrPlaybackQuerySchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { validate } from "../../http/validation/validate.js";
import {
  authorize,
  getStream,
  idempotent,
  missing,
  conflict,
  type Transaction,
} from "./repository.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import { dvrPlayback, drainDvrWindow } from "./dvr-service.js";
import type { StreamingRoutesOptions } from "./routes.js";

export const dvrRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const { database, config } = options,
    principal = registerStreamingManagementAuth(app, options);
  const scoped = async (db: Transaction, request: FastifyRequest, write = false) => {
    const { streamId } = validate(z.object({ streamId: streamingIdSchema }), request.params),
      query = validate(dvrPlaybackQuerySchema, request.query);
    const stream = await getStream(db, streamId, write);
    if (
      stream.status !== "active" ||
      (query.projectId && query.projectId !== stream.projectId) ||
      (query.environmentId && query.environmentId !== stream.environmentId)
    )
      throw missing();
    const auth = await authorize(
      db,
      principal(request),
      stream,
      write ? "streams:write" : "streams:read",
    );
    return { stream, auth, query };
  };
  app.get("/streams/:streamId/dvr-policy", (request) =>
    database.transaction(async (db) => {
      const { stream } = await scoped(db, request);
      const [p] = await db.execute(
        sql`SELECT policy,version FROM stream_dvr_policy WHERE stream_id=${stream.id}`,
      );
      return {
        policy: p ? dvrPolicySchema.parse(p.policy) : null,
        version: Number(p?.version ?? 0),
        effective: "next-run; disabling drains current runs",
      };
    }),
  );
  app.get("/streams/:streamId/dvr-playback", (request) =>
    database.transaction(async (db) => {
      const { stream, query } = await scoped(db, request);
      return dvrPlayback(db, stream, config, query.broadcastId);
    }),
  );
  const save = async (request: FastifyRequest, create: boolean) => {
    const input = validate(create ? configureDvrSchema : updateDvrSchema, request.body);
    return database.transaction(async (db) => {
      const { stream, auth } = await scoped(db, request, true),
        p = principal(request);
      return idempotent(
        db,
        `${p.type === "key" ? p.key.keyId : p.userId}:${request.method}:${request.url}`,
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined,
        input,
        create ? 201 : 200,
        async () => {
          if (input.policy.enabled && !config.dvrEnabled)
            throw conflict("DVR_DISABLED", "DVR is disabled by the operator.");
          if (input.policy.maxBytes > config.maxRecordingBytes - 1048576)
            throw conflict(
              "DVR_STORAGE_LIMIT",
              "Choose a byte cap below the recording storage cap.",
            );
          const [current] = await db.execute(
            sql`SELECT version FROM stream_dvr_policy WHERE stream_id=${stream.id} FOR UPDATE`,
          );
          const version = Number(current?.version ?? 0);
          if (
            (create && current) ||
            (!create && (!current || version !== ("version" in input ? input.version : 0)))
          )
            throw conflict("DVR_VERSION_CONFLICT", "Reload the DVR policy before saving.");
          await db.execute(
            sql`INSERT INTO stream_dvr_policy(stream_id,policy,version) VALUES(${stream.id},${JSON.stringify(input.policy)}::jsonb,${version + 1}) ON CONFLICT(stream_id) DO UPDATE SET policy=excluded.policy,version=excluded.version`,
          );
          // Prevent a grant/manifest race after disabling, while permitting a bounded drain.
          if (!input.policy.enabled) {
            const windows = await db.execute(
              sql`SELECT w.id,w.policy FROM dvr_window w JOIN recording r ON r.id=w.recording_id WHERE r.stream_id=${stream.id} AND w.state='active' ORDER BY w.id FOR UPDATE OF w`,
            );
            for (const w of windows)
              await drainDvrWindow(
                db,
                String(w.id),
                stream.id,
                dvrPolicySchema.parse(w.policy).endedRetentionSeconds,
              );
          }
          await recordAudit(db, {
            actor: auth.actor,
            action: "stream.dvr.policy.updated",
            outcome: "SUCCESS",
            organizationId: stream.organizationId,
            resourceType: "stream",
            resourceId: stream.id,
            correlationId: request.id,
          });
          return {
            policy: input.policy,
            version: version + 1,
            effective: "next-run; disabling drains current runs",
          };
        },
      );
    });
  };
  app.post("/streams/:streamId/dvr-policy", async (request, reply) =>
    reply.code(201).send(await save(request, true)),
  );
  app.patch("/streams/:streamId/dvr-policy", (request) => save(request, false));
  app.get("/dvr/openapi", () => dvrOpenApi());
  return Promise.resolve();
};
