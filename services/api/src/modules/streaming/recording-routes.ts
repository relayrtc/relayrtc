import { Readable } from "node:stream";
import { recordAudit } from "@relayrtc/auth/server";
import {
  signStreamingGrant,
  verifyStreamingGrant,
  streamingSecretHash,
} from "@relayrtc/protocol/streaming-control";
import {
  startRecordingSchema,
  recordingPolicySchema,
  assetAccessGrantSchema,
  streamScopeSchema,
  streamingIdSchema,
  streamingObjectNameSchema,
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
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";
import {
  admitRecording,
  deleteRecording,
  getRecording,
  publicAsset,
  publicRecording,
  recordingRowSchema,
} from "./recording-service.js";
import { StreamingStore } from "./store.js";

const pathSchema = z.object({
  streamId: streamingIdSchema.optional(),
  recordingId: streamingIdSchema.optional(),
  assetId: streamingIdSchema.optional(),
});
export const recordingRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const { database, config } = options,
    principal = registerStreamingManagementAuth(app, options);
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
  const scoped = async (db: Transaction, request: FastifyRequest, write = false) => {
    const path = validate(pathSchema, request.params),
      scope = validate(streamScopeSchema, request.query);
    const r = await getRecording(db, path.assetId ?? path.recordingId ?? "", !!path.assetId);
    if (
      (scope.projectId && scope.projectId !== r.project_id) ||
      (scope.environmentId && scope.environmentId !== r.environment_id)
    )
      throw missing();
    const stream = await getStream(db, r.stream_id, write);
    const auth = await authorize(
      db,
      principal(request),
      stream,
      write ? "recordings:create" : "recordings:read",
    );
    return { r: await getRecording(db, r.id, false, write), stream, auth };
  };
  const streamScoped = async (db: Transaction, request: FastifyRequest, write = false) => {
    const path = validate(pathSchema, request.params),
      scope = validate(streamScopeSchema, request.query);
    const stream = await getStream(db, path.streamId ?? "", write);
    if (
      stream.status !== "active" ||
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
    return { stream, auth };
  };
  const audited = async (
    db: Transaction,
    request: FastifyRequest,
    stream: Awaited<ReturnType<typeof getStream>>,
    auth: Awaited<ReturnType<typeof authorize>>,
    resourceId: string,
    action: string,
  ) =>
    recordAudit(db, {
      actor: auth.actor,
      action,
      outcome: "SUCCESS",
      organizationId: stream.organizationId,
      resourceType: "recording",
      resourceId,
      correlationId: request.id,
    });
  app.get("/streams/:streamId/recording-policy", (request) =>
    database.transaction(async (db) => {
      const { stream } = await streamScoped(db, request);
      const [row] = await db.execute(
        sql`SELECT policy,version FROM stream_recording_policy WHERE stream_id=${stream.id}`,
      );
      return row ?? { policy: null, version: 0 };
    }),
  );
  app.put("/streams/:streamId/recording-policy", (request) => {
    const input = validate(
      z.object({ version: z.number().int().nonnegative(), policy: recordingPolicySchema }).strict(),
      request.body,
    );
    return database.transaction(async (db) => {
      const { stream, auth } = await streamScoped(db, request, true);
      return command(db, request, input, 200, async () => {
        if (input.policy.region !== config.s3Region)
          throw conflict("RECORDING_REGION_UNAVAILABLE", "Select the configured storage region.");
        const [current] = await db.execute(
          sql`SELECT version FROM stream_recording_policy WHERE stream_id=${stream.id} FOR UPDATE`,
        );
        if (Number(current?.version ?? 0) !== input.version)
          throw conflict("RECORDING_POLICY_VERSION_CONFLICT", "Reload the recording policy.");
        await db.execute(
          sql`INSERT INTO stream_recording_policy(stream_id,policy,version) VALUES(${stream.id},${JSON.stringify(input.policy)}::jsonb,${input.version + 1}) ON CONFLICT(stream_id) DO UPDATE SET policy=excluded.policy,version=excluded.version,updated_at=now()`,
        );
        await audited(db, request, stream, auth, stream.id, "recording.policy.updated");
        return { policy: input.policy, version: input.version + 1 };
      });
    });
  });
  app.post("/streams/:streamId/recordings", async (request, reply) => {
    const input = validate(startRecordingSchema, request.body);
    const result = await database.transaction(async (db) => {
      const { stream, auth } = await streamScoped(db, request, true);
      return command(db, request, input, 201, async () => {
        const r = await admitRecording(db, stream, input.broadcastId, input.policy, config);
        await audited(db, request, stream, auth, r.id, "recording.start.requested");
        return publicRecording(r);
      });
    });
    return reply.code(201).send(result);
  });
  const list = (nested: boolean) => (request: FastifyRequest) =>
    database.transaction(async (db) => {
      const query = validate(
        streamScopeSchema.extend({
          cursor: streamingIdSchema.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
        request.query,
      );
      const p = principal(request);
      const stream = nested ? (await streamScoped(db, request)).stream : null;
      const projectId =
          stream?.projectId ?? query.projectId ?? (p.type === "key" ? p.key.projectId : undefined),
        environmentId =
          stream?.environmentId ??
          query.environmentId ??
          (p.type === "key" ? p.key.environmentId : undefined);
      if (!projectId || !environmentId)
        throw new ApiError(400, "SCOPE_REQUIRED", "Select a project and environment.");
      await authorize(db, p, { projectId, environmentId }, "recordings:read");
      const rows = await db.execute(
        sql`SELECT * FROM recording WHERE kind='recording' AND project_id=${projectId} AND environment_id=${environmentId} ${stream ? sql`AND stream_id=${stream.id}` : sql``} ${query.cursor ? sql`AND id>${query.cursor}` : sql``} ORDER BY id LIMIT ${query.limit + 1}`,
      );
      return {
        data: rows.slice(0, query.limit).map((r) => publicRecording(recordingRowSchema.parse(r))),
        nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?.id) : null,
      };
    });
  app.get("/recordings", list(false));
  app.get("/streams/:streamId/recordings", list(true));
  app.get("/recordings/:recordingId", (request) =>
    database.transaction(async (db) => publicRecording((await scoped(db, request)).r)),
  );
  app.get("/assets/:assetId", (request) =>
    database.transaction(async (db) => publicAsset((await scoped(db, request)).r)),
  );
  app.get("/recordings/:recordingId/playback", (request) =>
    database.transaction(async (db) => {
      const { r } = await scoped(db, request);
      return {
        mode: "vod",
        recordingId: r.id,
        assetId: r.asset_id,
        streamId: r.stream_id,
        sourceSessionId: r.asset_id,
        generation: r.grant_epoch,
        state:
          r.state === "ready"
            ? "ready"
            : r.state === "failed"
              ? "failed"
              : ["deleted", "deleting"].includes(r.state)
                ? "ended"
                : "starting",
        durationSeconds: r.duration_seconds,
        partial: r.partial,
        formats: publicAsset(r).formats,
      };
    }),
  );
  app.post("/recordings/:recordingId/stop", async (request, reply) => {
    validate(z.object({}).strict(), request.body ?? {});
    const result = await database.transaction(async (db) => {
      const { r, stream, auth } = await scoped(db, request, true);
      return command(db, request, {}, 202, async () => {
        await db.execute(sql`UPDATE recording SET stop_requested=true WHERE id=${r.id}`);
        await audited(db, request, stream, auth, r.id, "recording.stop.requested");
        return publicRecording(r);
      });
    });
    return reply.code(202).send(result);
  });
  const remove = async (request: FastifyRequest) =>
    database.transaction(async (db) => {
      const { r, stream, auth } = await scoped(db, request, true);
      return command(db, request, {}, 202, async () => {
        await audited(db, request, stream, auth, r.id, "recording.delete.requested");
        return publicRecording(await deleteRecording(db, r));
      });
    });
  app.delete("/recordings/:recordingId", async (request, reply) =>
    reply.code(202).send(await remove(request)),
  );
  app.delete("/assets/:assetId", async (request, reply) =>
    reply.code(202).send(await remove(request)),
  );
  app.post("/assets/:assetId/access-grants", async (request, reply) => {
    const input = validate(assetAccessGrantSchema, request.body ?? {});
    const result = await database.transaction(async (db) => {
      const { r, stream, auth } = await scoped(db, request);
      return command(db, request, input, 201, async () => {
        if (
          r.kind === "buffer" ||
          r.state !== "ready" ||
          !r.expires_at ||
          r.expires_at.getTime() <= Date.now() ||
          (r.partial && !r.policy.allowPartial)
        )
          throw conflict("ASSET_NOT_READY", "This asset is not available.");
        if (r.kind === "clip") {
          const [clip] = await db.execute(
            sql`SELECT published FROM clip_request WHERE recording_id=${r.id}`,
          );
          if (input.audience === "preview")
            await authorize(db, principal(request), stream, "recordings:create");
          else if (!clip?.published)
            throw conflict("CLIP_NOT_PUBLISHED", "Publish the clip before issuing viewer grants.");
        }
        if (input.action === "download" && !r.mp4_parts)
          throw conflict("ASSET_FORMAT_UNAVAILABLE", "MP4 export was not requested.");
        const grantId = id("agrant"),
          ttl = Math.min(
            input.ttlSeconds,
            Math.floor((r.expires_at.getTime() - Date.now()) / 1000),
          );
        if (ttl < 1) throw missing();
        const token = signStreamingGrant(
            config.secret,
            {
              aud: "streaming-asset",
              sub: grantId,
              streamId: r.stream_id,
              sessionId: r.asset_id,
              generation: r.grant_epoch,
              action: input.action,
            },
            ttl,
          ),
          expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        await db.execute(
          sql`INSERT INTO recording_access_grant(id,recording_id,token_hash,action,epoch,expires_at) VALUES(${grantId},${r.id},${streamingSecretHash(token)},${input.action},${r.grant_epoch},${expiresAt})`,
        );
        await audited(db, request, stream, auth, r.id, "recording.access_grant.created");
        return {
          assetId: r.asset_id,
          action: input.action,
          url: `${config.publicOrigin}/assets/${r.asset_id}/${input.action === "download" ? "download.mp4" : "index.m3u8"}?token=${encodeURIComponent(token)}`,
          expiresAt,
        };
      });
    });
    return reply.code(201).send(result);
  });
  return Promise.resolve();
};

export const assetMediaRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (
  app,
  { database, config },
) => {
  const store = new StreamingStore(config);
  const access = async (assetId: string, token: string, download: boolean) =>
    database.transaction(async (db) => {
      const claims = verifyStreamingGrant(config.secret, token, "streaming-asset");
      if (claims?.sessionId !== assetId || claims.action !== (download ? "download" : "playback"))
        throw new ApiError(401, "ASSET_GRANT_REQUIRED", "A current asset grant is required.");
      const r = await getRecording(db, assetId, true);
      const [owner] = await db.execute(
        sql`SELECT s.id FROM streaming_stream s JOIN project p ON p.id=s.project_id JOIN environment e ON e.id=s.environment_id JOIN organization o ON o.id=s.organization_id WHERE s.id=${r.stream_id} AND s.status='active' AND p.status='active' AND e.status='active' AND o.status='active'`,
      );
      const [grant] = await db.execute(
        sql`SELECT id FROM recording_access_grant WHERE id=${claims.sub} AND recording_id=${r.id} AND epoch=${r.grant_epoch} AND token_hash=${streamingSecretHash(token)} AND expires_at>now() AND revoked_at IS NULL`,
      );
      if (
        !owner ||
        !grant ||
        r.state !== "ready" ||
        r.grant_epoch !== claims.generation ||
        r.stream_id !== claims.streamId ||
        !r.expires_at ||
        r.expires_at.getTime() <= Date.now()
      )
        throw new ApiError(410, "ASSET_UNAVAILABLE", "The asset or grant is no longer available.");
      return r;
    });
  app.get("/assets/:assetId/:name", async (request, reply) => {
    const { assetId, name } = validate(
        z.object({
          assetId: streamingIdSchema,
          name: streamingObjectNameSchema.or(z.literal("thumbnail.jpg")),
        }),
        request.params,
      ),
      { token } = validate(
        z.object({ token: z.string().min(1).max(4096) }).strict(),
        request.query,
      );
    const download = name === "download.mp4",
      r = await access(assetId, token, download);
    reply
      .header("cache-control", "private, no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff");
    if (
      typeof request.headers.origin === "string" &&
      config.allowedOrigins.includes(request.headers.origin)
    )
      reply
        .header("access-control-allow-origin", request.headers.origin)
        .header("vary", "Origin")
        .header("access-control-expose-headers", "Content-Range, Accept-Ranges, Content-Length");
    if (download) {
      if (!r.mp4_parts) throw missing();
      const objects = await database.execute(
        sql`SELECT name,object_key,size_bytes FROM recording_object WHERE recording_id=${r.id} AND name LIKE ${`export_${String(r.export_fence)}_part_%.bin`} AND committed_at IS NOT NULL`,
      );
      const parts = objects.sort(
        (a, b) =>
          Number(/part_(\d+)/u.exec(String(a.name))?.[1]) -
          Number(/part_(\d+)/u.exec(String(b.name))?.[1]),
      );
      if (parts.length !== r.mp4_parts) throw missing();
      const total = parts.reduce((n, p) => n + Number(p.size_bytes), 0);
      let start = 0,
        end = total - 1;
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range);
        if (!range || (!range[1] && !range[2]))
          return reply
            .code(416)
            .header("content-range", `bytes */${String(total)}`)
            .send();
        if (!range[1]) start = Math.max(0, total - Number(range[2]));
        else {
          start = Number(range[1]);
          end = range[2] ? Math.min(end, Number(range[2])) : end;
        }
        if (start > end || start >= total)
          return reply
            .code(416)
            .header("content-range", `bytes */${String(total)}`)
            .send();
        reply
          .code(206)
          .header("content-range", `bytes ${String(start)}-${String(end)}/${String(total)}`);
      }
      reply
        .type("video/mp4")
        .header("accept-ranges", "bytes")
        .header("content-length", end - start + 1)
        .header("content-disposition", `attachment; filename="${r.asset_id}.mp4"`);
      async function* chunks() {
        let offset = 0;
        for (const part of parts) {
          const size = Number(part.size_bytes);
          if (offset + size > start && offset <= end) {
            await access(assetId, token, true);
            const body = await store.get(String(part.object_key));
            await access(assetId, token, true);
            yield body.subarray(Math.max(0, start - offset), Math.min(size, end - offset + 1));
          }
          offset += size;
        }
      }
      return reply.send(Readable.from(chunks()));
    }
    const actual = ["index.m3u8", "video.m3u8", "audio.m3u8"].includes(name)
      ? `vod_${String(r.export_fence)}${name === "index.m3u8" ? "" : name === "video.m3u8" ? "_video" : "_audio"}.m3u8`
      : name === "thumbnail.jpg"
        ? `export_${String(r.export_fence)}_thumb.jpg`
        : name;
    if (
      !/^(?:seg_[a-f0-9]{64}\.m4s|init_[a-f0-9]{64}\.mp4|vod_\d+(?:_video|_audio)?\.m3u8|export_\d+_thumb\.jpg|export_\d+_render_(?:init\.mp4|seg_\d{5}\.m4s))$/u.test(
        actual,
      )
    )
      throw missing();
    const [object] = await database.execute(
      sql`SELECT object_key FROM recording_object WHERE recording_id=${r.id} AND name=${actual} AND committed_at IS NOT NULL`,
    );
    if (!object) throw missing();
    let body = await store.get(String(object.object_key));
    await access(assetId, token, false);
    if (name.endsWith(".m3u8")) {
      body = Buffer.from(
        body
          .toString()
          .split("\n")
          .map((line) =>
            line.startsWith("#")
              ? line.replace(
                  /URI="([^"]+)"/gu,
                  (_m: string, value: string) =>
                    `URI="${value}?token=${encodeURIComponent(token)}"`,
                )
              : line
                ? `${line}?token=${encodeURIComponent(token)}`
                : line,
          )
          .join("\n"),
      );
    }
    return reply
      .type(
        name.endsWith("m3u8")
          ? "application/vnd.apple.mpegurl"
          : name.endsWith("jpg")
            ? "image/jpeg"
            : "video/mp4",
      )
      .send(body);
  });
  return Promise.resolve();
};
