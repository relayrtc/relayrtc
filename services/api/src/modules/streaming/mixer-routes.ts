import { mixerOpenApi } from "./mixer-openapi.js";
import { recordAudit } from "@relayrtc/auth/server";
import { decodeMixerPng } from "@relayrtc/protocol/mixer-png";
import { streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import {
  createMixerSchema,
  putMixerSceneSchema,
  activateMixerSceneSchema,
  createMixerOverlaySchema,
  mixerSceneSchema,
  streamingIdSchema,
  streamScopeSchema,
} from "@relayrtc/validation";
import { sql } from "drizzle-orm";
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
import { getBroadcast } from "./broadcast-service.js";
import {
  getMixer,
  publicMixer,
  mixerOperation,
  validateMixerScene,
  requestMixerStop,
} from "./mixer-service.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";
import { StreamingStore } from "./store.js";

const paths = z.object({
  broadcastId: streamingIdSchema.optional(),
  mixerId: streamingIdSchema.optional(),
  sceneId: streamingIdSchema.optional(),
  overlayId: streamingIdSchema.optional(),
  operationId: streamingIdSchema.optional(),
});
export const mixerRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const { database, config } = options,
    principal = registerStreamingManagementAuth(app, options),
    store = new StreamingStore(config);
  const scoped = async (db: Transaction, request: FastifyRequest, write = false) => {
    const path = validate(paths, request.params),
      scope = validate(streamScopeSchema, request.query);
    const op = path.operationId ? await mixerOperation(db, path.operationId) : null;
    const initial = await getMixer(db, op?.mixerId ?? path.mixerId ?? "");
    const stream = await getStream(db, initial.stream_id, write);
    if (
      (scope.projectId && scope.projectId !== stream.projectId) ||
      (scope.environmentId && scope.environmentId !== stream.environmentId)
    )
      throw missing();
    const auth = await authorize(
      db,
      principal(request),
      stream,
      write ? "streams:write" : "streams:read",
    );
    return { m: await getMixer(db, initial.id, write), stream, auth, path, op };
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
  app.get("/mixers/openapi", () => mixerOpenApi());
  app.post("/broadcasts/:broadcastId/mixers", async (request, reply) => {
    const input = validate(createMixerSchema, request.body ?? {});
    const result = await database.transaction(async (db) => {
      const { broadcastId } = validate(paths, request.params),
        run = await getBroadcast(db, broadcastId ?? ""),
        stream = await getStream(db, run.streamId, true);
      const scope = validate(streamScopeSchema, request.query);
      if (
        (scope.projectId && scope.projectId !== run.projectId) ||
        (scope.environmentId && scope.environmentId !== run.environmentId)
      )
        throw missing();
      const auth = await authorize(db, principal(request), stream, "streams:write");
      await authorize(db, principal(request), stream, "streams:publish");
      return command(db, request, input, 201, async () => {
        if (!config.mixersEnabled)
          throw new ApiError(503, "MIXERS_DISABLED", "Mixer admission is disabled.");
        if (["stopping", "stopped", "failed"].includes(run.state))
          throw conflict("MIXER_RUN_ENDED", "Choose a created or running broadcast.");
        const profile = z
          .object({
            audioOnly: z.boolean(),
            width: z.number(),
            height: z.number(),
            fps: z.number(),
          })
          .parse(stream.profile);
        if (profile.audioOnly || profile.width > 1280 || profile.height > 720 || profile.fps > 30)
          throw conflict(
            "MIXER_PROFILE_LIMIT",
            "Use a video output profile up to 1280x720 at 30 fps.",
          );
        await db.execute(sql`SELECT pg_advisory_xact_lock(810041)`);
        const [count] = await db.execute(
          sql`SELECT count(*) FILTER(WHERE state NOT IN ('stopped','failed'))::int AS active,count(*) FILTER(WHERE environment_id=${run.environmentId} AND state NOT IN ('stopped','failed'))::int AS environment,count(*) FILTER(WHERE broadcast_id=${run.id})::int AS history FROM mixer`,
        );
        if (
          Number(count?.active) >= config.maxMixers ||
          Number(count?.environment) >= config.maxMixersPerEnvironment ||
          Number(count?.history) >= 10
        )
          throw conflict(
            "MIXER_CAPACITY",
            "Mixer capacity or the per-broadcast definition limit is full.",
          );
        const [exclusive] = await db.execute(
          sql`SELECT id FROM broadcast_run WHERE stream_id=${stream.id} AND id<>${run.id} AND desired_state='running' AND state NOT IN ('stopped','failed')`,
        );
        const [feedback] = await db.execute(
          sql`SELECT m.id FROM mixer_source s JOIN mixer m ON m.id=s.mixer_id WHERE s.stream_id=${stream.id} AND m.state NOT IN ('stopped','failed')`,
        );
        if (exclusive || feedback)
          throw conflict(
            "MIXER_EXCLUSIVE_SOURCE",
            "A mixer needs an exclusive broadcast stream that is not another mixer's input.",
          );
        for (const source of input.sources) {
          const selected = await getStream(db, source.streamId);
          if (
            selected.id === stream.id ||
            selected.projectId !== run.projectId ||
            selected.environmentId !== run.environmentId ||
            selected.status !== "active"
          )
            throw conflict(
              "MIXER_SOURCE_SCOPE",
              "Choose independent streams in the same project and environment.",
            );
          const sourceProfile = z
            .object({
              audioOnly: z.boolean(),
              width: z.number(),
              height: z.number(),
              fps: z.number(),
            })
            .parse(selected.profile);
          if (
            !sourceProfile.audioOnly &&
            (sourceProfile.width > 1280 || sourceProfile.height > 720 || sourceProfile.fps > 30)
          )
            throw conflict("MIXER_PROFILE_LIMIT", "Use input streams up to 1280x720 at 30 fps.");
          await authorize(db, principal(request), selected, "streams:read");
          const [nested] = await db.execute(
            sql`SELECT id FROM mixer WHERE stream_id=${selected.id} AND state NOT IN ('stopped','failed')`,
          );
          if (nested)
            throw conflict("MIXER_FEEDBACK_FORBIDDEN", "Nested mixer inputs are not supported.");
        }
        const key = id("mixer");
        await db.execute(
          sql`INSERT INTO mixer(id,broadcast_id,stream_id,project_id,environment_id) VALUES(${key},${run.id},${stream.id},${run.projectId},${run.environmentId})`,
        );
        for (const source of [{ id: "primary", streamId: stream.id }, ...input.sources])
          await db.execute(
            sql`INSERT INTO mixer_source(mixer_id,id,stream_id) VALUES(${key},${source.id},${source.streamId})`,
          );
        await recordAudit(db, {
          actor: auth.actor,
          action: "mixer.created",
          outcome: "SUCCESS",
          organizationId: run.organizationId,
          resourceType: "mixer",
          resourceId: key,
          correlationId: request.id,
        });
        return publicMixer(db, await getMixer(db, key));
      });
    });
    return reply.code(201).send(result);
  });
  app.get("/broadcasts/:broadcastId/mixers", (request) =>
    database.transaction(async (db) => {
      const path = validate(paths, request.params),
        run = await getBroadcast(db, path.broadcastId ?? ""),
        scope = validate(streamScopeSchema, request.query);
      if (
        (scope.projectId && scope.projectId !== run.projectId) ||
        (scope.environmentId && scope.environmentId !== run.environmentId)
      )
        throw missing();
      await authorize(db, principal(request), run, "streams:read");
      const rows = await db.execute(
        sql`SELECT id FROM mixer WHERE broadcast_id=${run.id} ORDER BY created_at DESC LIMIT 10`,
      );
      return {
        data: await Promise.all(
          rows.map((row) => getMixer(db, String(row.id)).then((m) => publicMixer(db, m))),
        ),
      };
    }),
  );
  app.get("/mixers/:mixerId", (request) =>
    database.transaction(async (db) => publicMixer(db, (await scoped(db, request)).m)),
  );
  app.get("/mixer-operations/:operationId", (request) =>
    database.transaction(async (db) => (await scoped(db, request)).op),
  );
  app.get("/mixers/:mixerId/scenes", (request) =>
    database.transaction(async (db) => {
      const { m } = await scoped(db, request);
      const rows = await db.execute(
        sql`SELECT id,version,scene FROM mixer_scene WHERE mixer_id=${m.id} ORDER BY id LIMIT 12`,
      );
      return {
        data: rows.map((r) => ({
          id: String(r.id),
          mixerId: m.id,
          version: Number(r.version),
          scene: mixerSceneSchema.parse(r.scene),
        })),
      };
    }),
  );
  app.put("/mixers/:mixerId/scenes/:sceneId", (request) => {
    const input = validate(putMixerSceneSchema, request.body);
    return database.transaction(async (db) => {
      const { m, path, stream, auth } = await scoped(db, request, true);
      return command(db, request, input, 200, async () => {
        await validateMixerScene(db, m, input.scene);
        const [current] = await db.execute(
          sql`SELECT version FROM mixer_scene WHERE mixer_id=${m.id} AND id=${path.sceneId ?? ""}`,
        );
        if (Number(current?.version ?? 0) !== input.version)
          throw conflict("MIXER_SCENE_VERSION_CONFLICT", "Reload the scene before editing.");
        const [count] = await db.execute(
          sql`SELECT count(*)::int AS n FROM mixer_scene WHERE mixer_id=${m.id}`,
        );
        if (!current && Number(count?.n) >= 12)
          throw conflict("MIXER_SCENE_LIMIT", "This mixer has twelve scenes.");
        await db.execute(
          sql`INSERT INTO mixer_scene(mixer_id,id,version,scene) VALUES(${m.id},${path.sceneId ?? ""},${input.version + 1},${JSON.stringify(input.scene)}::jsonb) ON CONFLICT(mixer_id,id) DO UPDATE SET version=excluded.version,scene=excluded.scene`,
        );
        await recordAudit(db, {
          actor: auth.actor,
          action: "mixer.scene.updated",
          outcome: "SUCCESS",
          organizationId: stream.organizationId,
          resourceType: "mixer",
          resourceId: m.id,
          correlationId: request.id,
        });
        return { id: path.sceneId, mixerId: m.id, version: input.version + 1, scene: input.scene };
      });
    });
  });
  app.post("/mixers/:mixerId/activate-scene", async (request, reply) => {
    const input = validate(activateMixerSceneSchema, request.body);
    const result = await database.transaction(async (db) => {
      const { m, stream, auth } = await scoped(db, request, true);
      await authorize(db, principal(request), stream, "streams:publish");
      return command(db, request, input, 202, async () => {
        if (m.version !== input.version)
          throw conflict("MIXER_VERSION_CONFLICT", "Reload the mixer before activation.");
        const profile = z
          .object({
            audioOnly: z.boolean(),
            width: z.number(),
            height: z.number(),
            fps: z.number(),
          })
          .parse(stream.profile);
        if (profile.audioOnly || profile.width > 1280 || profile.height > 720 || profile.fps > 30)
          throw conflict("MIXER_PROFILE_LIMIT", "Use a video profile up to 1280x720 at 30 fps.");
        const [pending] = await db.execute(
          sql`SELECT id FROM mixer_operation WHERE mixer_id=${m.id} AND status='pending'`,
        );
        if (pending)
          throw conflict("MIXER_ACTIVATION_PENDING", "Wait for the current command to finish.");
        const [source] = await db.execute(
          sql`SELECT s.id FROM streaming_session s JOIN broadcast_run b ON b.stream_id=s.stream_id WHERE b.id=${m.broadcast_id} AND b.desired_state='running' AND s.desired_state='running' AND s.state='live' AND s.leased_until>now()`,
        );
        if (!source)
          throw conflict(
            "MIXER_SOURCE_REQUIRED",
            "Start the primary source and broadcast before activating.",
          );
        const [scene] = await db.execute(
          sql`SELECT version,scene FROM mixer_scene WHERE mixer_id=${m.id} AND id=${input.sceneId}`,
        );
        if (!scene || Number(scene.version) !== input.sceneVersion)
          throw conflict("MIXER_SCENE_VERSION_CONFLICT", "Reload the selected scene.");
        const snapshot = mixerSceneSchema.parse(scene.scene);
        await validateMixerScene(db, m, snapshot);
        await db.execute(
          sql`UPDATE mixer SET version=version+1,desired_version=desired_version+1,desired_scene_id=${input.sceneId},snapshot=${JSON.stringify(snapshot)}::jsonb,state='preparing',activated_at=now(),last_error=NULL WHERE id=${m.id}`,
        );
        const key = id("mop");
        await db.execute(
          sql`INSERT INTO mixer_operation(id,mixer_id,kind,revision) VALUES(${key},${m.id},'activate',${m.desired_version + 1})`,
        );
        await recordAudit(db, {
          actor: auth.actor,
          action: "mixer.scene.activation_requested",
          outcome: "SUCCESS",
          organizationId: stream.organizationId,
          resourceType: "mixer",
          resourceId: m.id,
          correlationId: request.id,
        });
        return {
          mixer: await publicMixer(db, await getMixer(db, m.id)),
          operation: await mixerOperation(db, key),
        };
      });
    });
    return reply.code(202).send(result);
  });
  app.post("/mixers/:mixerId/stop", async (request, reply) => {
    const input = validate(
      z.object({ version: z.number().int().positive() }).strict(),
      request.body,
    );
    const result = await database.transaction(async (db) => {
      const { m, stream, auth } = await scoped(db, request, true);
      return command(db, request, input, 202, async () => {
        if (m.version !== input.version)
          throw conflict("MIXER_VERSION_CONFLICT", "Reload the mixer.");
        await requestMixerStop(db, m);
        const key = id("mop");
        await db.execute(
          sql`INSERT INTO mixer_operation(id,mixer_id,kind,revision,status,completed_at) VALUES(${key},${m.id},'stop',${m.desired_version},${["stopped", "failed"].includes(m.state) ? "completed" : "pending"},${["stopped", "failed"].includes(m.state) ? new Date() : null})`,
        );
        await recordAudit(db, {
          actor: auth.actor,
          action: "mixer.stop_requested",
          outcome: "SUCCESS",
          organizationId: stream.organizationId,
          resourceType: "mixer",
          resourceId: m.id,
          correlationId: request.id,
        });
        return {
          mixer: await publicMixer(db, await getMixer(db, m.id)),
          operation: await mixerOperation(db, key),
        };
      });
    });
    return reply.code(202).send(result);
  });
  app.post("/mixers/:mixerId/overlays", { bodyLimit: 1500000 }, async (request, reply) => {
    const input = validate(createMixerOverlaySchema, request.body),
      body = Buffer.from(input.dataBase64, "base64");
    let image: { width: number; height: number };
    try {
      image = decodeMixerPng(body);
    } catch {
      throw new ApiError(
        400,
        "MIXER_OVERLAY_INVALID",
        "Use a valid non-interlaced 8-bit RGB/RGBA PNG, up to 640x360 and 1 MiB.",
      );
    }
    const resource = await database.transaction(async (db) => {
      const { m, stream, auth } = await scoped(db, request, true);
      const result = await command(db, request, input, 201, async () => {
        if (m.desired_state !== "running")
          throw conflict("MIXER_STOPPED", "This mixer has stopped.");
        const [count] = await db.execute(
          sql`SELECT count(*)::int AS n FROM mixer_overlay WHERE mixer_id=${m.id} AND state<>'deleted'`,
        );
        if (Number(count?.n) >= 8)
          throw conflict("MIXER_OVERLAY_LIMIT", "This mixer has eight overlays.");
        const key = id("overlay"),
          objectKey = `streaming/mixers/${stream.projectId}/${stream.environmentId}/${m.id}/${key}.png`;
        await db.execute(
          sql`INSERT INTO mixer_overlay(id,mixer_id,name,width,height,size_bytes,sha256,object_key) VALUES(${key},${m.id},${input.name},${image.width},${image.height},${body.length},${streamingSecretHash(body)},${objectKey})`,
        );
        await recordAudit(db, {
          actor: auth.actor,
          action: "mixer.overlay.admitted",
          outcome: "SUCCESS",
          organizationId: stream.organizationId,
          resourceType: "mixer",
          resourceId: m.id,
          correlationId: request.id,
        });
        return { id: key };
      });
      return z.object({ id: z.string() }).parse(result);
    });
    const [o] = await database.execute(sql`SELECT * FROM mixer_overlay WHERE id=${resource.id}`);
    if (!o) throw missing();
    if (o.state === "pending") {
      await store.put(String(o.object_key), body);
      await database.execute(
        sql`UPDATE mixer_overlay SET state='ready' WHERE id=${resource.id} AND state='pending'`,
      );
    }
    const [ready] = await database.execute(
      sql`SELECT state FROM mixer_overlay WHERE id=${resource.id}`,
    );
    if (ready?.state !== "ready")
      throw conflict("MIXER_OVERLAY_UNAVAILABLE", "The overlay has been retired.");
    return reply.code(201).send({
      id: resource.id,
      name: String(o.name),
      width: Number(o.width),
      height: Number(o.height),
      sizeBytes: Number(o.size_bytes),
    });
  });
  app.delete("/mixers/:mixerId/overlays/:overlayId", (request) =>
    database.transaction(async (db) => {
      const { m, path, stream, auth } = await scoped(db, request, true);
      return command(db, request, {}, 200, async () => {
        const scenes = await db.execute(sql`SELECT scene FROM mixer_scene WHERE mixer_id=${m.id}`);
        if (
          !["stopped", "failed"].includes(m.state) &&
          [
            ...scenes.map((s) => mixerSceneSchema.parse(s.scene)),
            ...(m.snapshot ? [m.snapshot] : []),
            ...(m.applied_snapshot ? [m.applied_snapshot] : []),
          ].some((s) => s.overlays.some((o) => o.overlayId === path.overlayId))
        )
          throw conflict(
            "MIXER_OVERLAY_IN_USE",
            "Remove the overlay from saved and active scenes first, or stop the mixer.",
          );
        const rows = await db.execute(
          sql`UPDATE mixer_overlay SET state='deleting',deletion_requested_at=coalesce(deletion_requested_at,now()) WHERE id=${path.overlayId ?? ""} AND mixer_id=${m.id} AND state<>'deleted' RETURNING id`,
        );
        if (!rows.length) {
          const [exists] = await db.execute(
            sql`SELECT id FROM mixer_overlay WHERE id=${path.overlayId ?? ""} AND mixer_id=${m.id}`,
          );
          if (!exists) throw missing();
        }
        await recordAudit(db, {
          actor: auth.actor,
          action: "mixer.overlay.deleted",
          outcome: "SUCCESS",
          organizationId: stream.organizationId,
          resourceType: "mixer",
          resourceId: m.id,
          correlationId: request.id,
        });
        return { id: path.overlayId, deleted: true };
      });
    }),
  );
  return Promise.resolve();
};
