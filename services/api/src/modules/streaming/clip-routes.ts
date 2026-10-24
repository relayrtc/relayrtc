import { clipOpenApi } from "./clip-openapi.js";
import { recordAudit } from "@relayrtc/auth/server";
import {
  createClipSchema,
  rollingBufferPolicySchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { validate } from "../../http/validation/validate.js";
import { ApiError } from "../../http/errors/api-error.js";
import {
  authorize,
  getStream,
  idempotent,
  missing,
  conflict,
  type Transaction,
} from "./repository.js";
import { getRecording, deleteRecording } from "./recording-service.js";
import { createClip, getClip, clipWindows } from "./clip-service.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";

export const clipRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const { database, config } = options,
    principal = registerStreamingManagementAuth(app, options);
  const scoped = async (db: Transaction, request: FastifyRequest, write = false) => {
    const path = validate(
      z.object({ streamId: streamingIdSchema.optional(), clipId: streamingIdSchema.optional() }),
      request.params,
    );
    const clip = path.clipId ? await getClip(db, path.clipId) : null;
    const stream = await getStream(db, clip?.streamId ?? path.streamId ?? "", write);
    const scope = validate(streamScopeSchema, request.query);
    if (
      (scope.projectId && scope.projectId !== stream.projectId) ||
      (scope.environmentId && scope.environmentId !== stream.environmentId)
    )
      throw missing();
    const auth = await authorize(
      db,
      principal(request),
      stream,
      write ? "recordings:create" : "recordings:read",
    );
    return { stream, clip, auth };
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
  app.get("/clips/openapi", () => clipOpenApi());
  app.get("/streams/:streamId/clip-window", (request) =>
    database.transaction(async (db) => {
      const { stream } = await scoped(db, request);
      return { data: await clipWindows(db, stream.id) };
    }),
  );
  app.get("/streams/:streamId/buffer-policy", (request) =>
    database.transaction(async (db) => {
      const { stream } = await scoped(db, request);
      const [p] = await db.execute(
        sql`SELECT policy,version FROM stream_buffer_policy WHERE stream_id=${stream.id}`,
      );
      return p ?? { policy: null, version: 0 };
    }),
  );
  app.put("/streams/:streamId/buffer-policy", (request) => {
    const input = validate(
      z
        .object({ version: z.number().int().nonnegative(), policy: rollingBufferPolicySchema })
        .strict(),
      request.body,
    );
    return database.transaction(async (db) => {
      const { stream, auth } = await scoped(db, request, true);
      return command(db, request, input, 200, async () => {
        if (input.policy.maxBytes > config.maxRecordingBytes - 1048576)
          throw conflict(
            "BUFFER_STORAGE_LIMIT",
            "Choose a buffer cap below the recording storage cap.",
          );
        const [p] = await db.execute(
          sql`SELECT version FROM stream_buffer_policy WHERE stream_id=${stream.id} FOR UPDATE`,
        );
        if (Number(p?.version ?? 0) !== input.version)
          throw conflict("BUFFER_VERSION_CONFLICT", "Reload the buffer policy.");
        await db.execute(
          sql`INSERT INTO stream_buffer_policy(stream_id,policy,version) VALUES(${stream.id},${JSON.stringify(input.policy)}::jsonb,${input.version + 1}) ON CONFLICT(stream_id) DO UPDATE SET policy=excluded.policy,version=excluded.version`,
        );
        await recordAudit(db, {
          actor: auth.actor,
          action: "clip.buffer.updated",
          outcome: "SUCCESS",
          organizationId: stream.organizationId,
          resourceType: "stream",
          resourceId: stream.id,
          correlationId: request.id,
        });
        return { policy: input.policy, version: input.version + 1 };
      });
    });
  });
  app.post("/streams/:streamId/clips", async (request, reply) => {
    const input = validate(createClipSchema, request.body);
    const result = await database.transaction(async (db) => {
      const { stream, auth } = await scoped(db, request, true);
      return command(db, request, input, 202, async () => {
        const clip = await createClip(db, stream, input, config);
        await recordAudit(db, {
          actor: auth.actor,
          action: "clip.requested",
          outcome: "SUCCESS",
          organizationId: stream.organizationId,
          resourceType: "clip",
          resourceId: clip.id,
          correlationId: request.id,
        });
        return clip;
      });
    });
    return reply.code(202).send(result);
  });
  const list = (nested: boolean) => (request: FastifyRequest) =>
    database.transaction(async (db) => {
      const q = validate(
          streamScopeSchema.extend({
            cursor: streamingIdSchema.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(30),
          }),
          request.query,
        );
      const stream = nested ? (await scoped(db, request)).stream : null;
      const actor = principal(request);
      const projectId = stream?.projectId ?? q.projectId ?? (actor.type === "key" ? actor.key.projectId : undefined);
      const environmentId = stream?.environmentId ?? q.environmentId ?? (actor.type === "key" ? actor.key.environmentId : undefined);
      if (!projectId || !environmentId) throw new ApiError(400, "SCOPE_REQUIRED", "Select a project and environment.");
      await authorize(db, actor, { projectId, environmentId }, "recordings:read");
      const rows = await db.execute(
        sql`SELECT c.id FROM clip_request c JOIN recording r ON r.id=c.recording_id WHERE r.project_id=${projectId} AND r.environment_id=${environmentId} ${stream ? sql`AND r.stream_id=${stream.id}` : sql``} ${q.cursor ? sql`AND c.id>${q.cursor}` : sql``} ORDER BY c.id LIMIT ${q.limit + 1}`,
      );
      const data = await Promise.all(rows.slice(0, q.limit).map((r) => getClip(db, String(r.id))));
      return { data, nextCursor: rows.length > q.limit ? String(rows[q.limit - 1]?.id) : null };
    });
  app.get("/streams/:streamId/clips", list(true));
  app.get("/clips", list(false));
  app.get("/clips/:clipId", (request) =>
    database.transaction(async (db) => (await scoped(db, request)).clip),
  );
  for (const action of ["publish", "delete"] as const) {
    const handle = async (request: FastifyRequest) =>
      database.transaction(async (db) => {
        if (action === "publish") validate(z.object({}).strict(), request.body ?? {});
        const { clip, stream, auth } = await scoped(db, request, true);
        if (!clip) throw missing();
        return command(db, request, {}, action === "delete" ? 202 : 200, async () => {
          const r = await getRecording(db, clip.recordingId, false, true);
          if (action === "delete") await deleteRecording(db, r);
          else {
            await authorize(db, principal(request), stream, "streams:publish");
            if (r.state !== "ready" || !r.expires_at || r.expires_at.getTime() <= Date.now())
              throw conflict("CLIP_NOT_READY", "Wait for the clip to finish rendering.");
            await db.execute(sql`UPDATE clip_request SET published=true WHERE id=${clip.id}`);
          }
          await recordAudit(db, {
            actor: auth.actor,
            action: `clip.${action}`,
            outcome: "SUCCESS",
            organizationId: stream.organizationId,
            resourceType: "clip",
            resourceId: clip.id,
            correlationId: request.id,
          });
          return getClip(db, clip.id);
        });
      });
    if (action === "publish") app.post("/clips/:clipId/publish", handle);
    else
      app.delete("/clips/:clipId", async (request, reply) =>
        reply.code(202).send(await handle(request)),
      );
  }
  return Promise.resolve();
};
