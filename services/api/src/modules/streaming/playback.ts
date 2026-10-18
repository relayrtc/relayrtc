import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { verifyStreamingGrant, streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import { streamingIdSchema, streamingObjectNameSchema } from "@relayrtc/validation";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import type { StreamingConfig } from "./config.js";
import { programPath } from "./gateway.js";
import { getStream, type Transaction, type SessionRow, type StreamRow } from "./repository.js";
import { leased } from "./runtime-routes.js";
import { boundedBody, StreamingStore } from "./store.js";

const contentType = (name: string) =>
  name.endsWith("m3u8")
    ? "application/vnd.apple.mpegurl"
    : name.endsWith("ts")
      ? "video/mp2t"
      : "video/mp4";
const childNames = (body: string): string[] => {
  const names = new Set<string>();
  for (const line of body.split(/\r?\n/u)) {
    if (line && !line.startsWith("#")) names.add(line.trim());
    for (const match of line.matchAll(/URI="([^"]+)"/gu))
      if (!line.startsWith("#EXT-X-PRELOAD-HINT")) names.add(required(match[1]));
  }
  return [...names].map((name) => streamingObjectNameSchema.parse(name));
};
export class StreamingOrigin {
  readonly store: StreamingStore;
  constructor(
    readonly database: RelayKitDatabase,
    readonly config: StreamingConfig,
  ) {
    this.store = new StreamingStore(config);
  }
  async commit(
    stream: StreamRow,
    session: SessionRow,
    name: string,
    body: Buffer,
    references: string[] = [],
  ) {
    const digest = streamingSecretHash(body);
    const immutableName = name.endsWith("m3u8") ? `manifest_${digest}.m3u8` : name;
    const key = `streaming/${stream.organizationId}/${stream.projectId}/${stream.environmentId}/${session.id}/${immutableName}`;
    // Reserve before PUT. A crash leaves a named pending upload that retention can remove.
    const alreadyCommitted = await this.database.transaction(async (db) => {
      const [owner] =
        await db.execute(sql`SELECT t.id FROM streaming_stream t JOIN streaming_session s ON s.stream_id=t.id
        WHERE t.id=${stream.id} AND s.id=${session.id} AND t.status='active' AND s.desired_state='running' AND s.generation=${session.generation} FOR SHARE OF t,s`);
      if (!owner)
        throw new ApiError(410, "PLAYBACK_ENDED", "This playback session is no longer available");
      if (references.length) {
        const children = await db.execute(
          sql`SELECT name FROM streaming_object WHERE session_id=${session.id} AND name=ANY(ARRAY[${sql.join(
            references.map((name) => sql`${name}`),
            sql`, `,
          )}]::text[]) AND committed_at IS NOT NULL FOR SHARE`,
        );
        if (children.length !== new Set(references).size)
          throw new Error("PLAYLIST_OBJECT_NOT_COMMITTED");
      }
      await db.execute(sql`INSERT INTO streaming_object(session_id,name,object_key,size_bytes,sha256,content_type,referenced_names,expires_at)
        VALUES(${session.id},${immutableName},${key},${body.length},${digest},${contentType(name)},ARRAY[${sql.join(
          references.map((name) => sql`${name}`),
          sql`, `,
        )}]::text[],now()+interval '60 seconds') ON CONFLICT DO NOTHING`);
      const [existing] = await db.execute(
        sql`SELECT sha256,committed_at FROM streaming_object WHERE session_id=${session.id} AND name=${immutableName} FOR UPDATE`,
      );
      if (existing?.sha256 !== digest) throw new Error("IMMUTABLE_MEDIA_CONFLICT");
      await db.execute(
        sql`UPDATE streaming_object SET expires_at=greatest(expires_at,now()+make_interval(secs=>${existing.committed_at ? stream.retentionSeconds : 60})) WHERE session_id=${session.id} AND name=${immutableName}`,
      );
      return existing.committed_at !== null;
    });
    if (alreadyCommitted) return;
    await this.store.put(key, body);
    const committed = await this.database.execute(
      sql`UPDATE streaming_object SET committed_at=coalesce(committed_at,now()),expires_at=greatest(expires_at,now()+make_interval(secs=>${stream.retentionSeconds})) WHERE session_id=${session.id} AND name=${immutableName} AND sha256=${digest} RETURNING name`,
    );
    if (!committed.length) {
      await this.store.remove(key);
      throw new Error("MEDIA_UPLOAD_RETIRED");
    }
  }
  async media(
    stream: StreamRow,
    session: SessionRow,
    name: string,
    generation: number,
    query = "",
  ): Promise<Buffer> {
    const storedName = `g${String(generation)}_${name}`;
    if (!name.endsWith("m3u8")) {
      const cached = await this.database.transaction(async (db) => {
        const [stored] = await db.execute(
          sql`UPDATE streaming_object o SET expires_at=greatest(expires_at,now()+make_interval(secs=>${stream.retentionSeconds})) WHERE session_id=${session.id} AND name=${storedName} AND committed_at IS NOT NULL AND (expires_at>now() OR EXISTS(SELECT 1 FROM streaming_object m WHERE m.session_id=o.session_id AND o.name=ANY(m.referenced_names) AND m.expires_at>now())) RETURNING object_key`,
        );
        return stored ? this.store.get(String(stored.object_key)) : null;
      });
      if (cached) return cached;
    }
    if (generation !== session.generation)
      throw new ApiError(410, "PLAYBACK_OBJECT_EXPIRED", "This playback object has expired");
    // MediaMTX 1.21 HLS browser sessions redirect and add private session URIs.
    // Use its protected reverse-proxy mode so our own scoped playback grants
    // remain authoritative and the gateway emits clean, relative media names.
    const response = await fetch(
      `${this.config.gatewayHls}/${programPath(session.id, generation)}/${name}${query}`,
      {
        headers: { authorization: `Bearer ${this.config.gatewayKey}` },
        signal: AbortSignal.timeout(12000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        response.status === 404 ? 404 : 503,
        "PLAYBACK_NOT_READY",
        "The requested playback media is not ready",
      );
    }
    const body = await boundedBody(response, name.endsWith("m3u8") ? 262144 : undefined);
    if (!name.endsWith("m3u8")) await this.commit(stream, session, storedName, body);
    return body;
  }
  async snapshot(
    stream: StreamRow,
    session: SessionRow,
    name = "index.m3u8",
    depth = 0,
  ): Promise<void> {
    if (depth > 2) throw new Error("INVALID_PLAYLIST_DEPTH");
    const body = await this.media(stream, session, name, session.generation);
    if (!name.endsWith("m3u8")) return;
    const text = body.toString();
    if (!text.startsWith("#EXTM3U") || text.includes("#EXT-X-KEY"))
      throw new Error("UNSUPPORTED_PLAYLIST");
    const children = childNames(text);
    if (children.length > 128) throw new Error("PLAYLIST_TOO_LARGE");
    for (const child of children) await this.snapshot(stream, session, child, depth + 1);
    // Retained snapshots contain only complete media and use the same generation names
    // as committed objects. Child playlists remain live resources, not VOD assets.
    if (!children.some((child) => child.endsWith("m3u8"))) {
      const retained = text
        .split(/\r?\n/u)
        .filter((line) => !line.startsWith("#EXT-X-PRELOAD-HINT"))
        .map((line) =>
          line.startsWith("#")
            ? line.replace(
                /URI="([^"]+)"/gu,
                (_match: string, value: string) => `URI="g${String(session.generation)}_${value}"`,
              )
            : line
              ? `g${String(session.generation)}_${line.trim()}`
              : line,
        )
        .join("\n");
      await this.commit(
        stream,
        session,
        `g${String(session.generation)}_${name}`,
        Buffer.from(retained),
        children.map((child) => `g${String(session.generation)}_${child}`),
      );
    }
  }
}
const querySchema = z
  .object({
    token: z.string().max(4096).optional(),
    _HLS_msn: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    _HLS_part: z.coerce.number().int().min(0).max(10000).optional(),
    _HLS_skip: z.enum(["YES", "v2"]).optional(),
  })
  .strict();
export const playbackRoutes: FastifyPluginAsync<{
  database: RelayKitDatabase;
  config: StreamingConfig;
}> = (app, { database, config }) => {
  const origin = new StreamingOrigin(database, config);
  app.post("/internal/v1/streaming/archive", async (request) => {
    const data = await database.transaction(async (db) => {
      const { session } = await leased(db, config, request);
      return { session, stream: await getStream(db, session.streamId) };
    });
    if (data.session.desiredState !== "running") return { stop: true };
    await origin.snapshot(data.stream, data.session);
    return { ok: true };
  });
  const path = "/v1/playback/:streamId/:sessionId/:name";
  app.options(path, async (request, reply) => {
    if (request.headers.origin && config.allowedOrigins.includes(request.headers.origin))
      reply.header("access-control-allow-origin", request.headers.origin).header("vary", "Origin");
    return reply
      .header("access-control-allow-methods", "GET,HEAD,OPTIONS")
      .header("access-control-allow-headers", "Authorization,Range")
      .code(204)
      .send();
  });
  app.get(path, async (request, reply) => {
    const params = validate(
        z.object({
          streamId: streamingIdSchema,
          sessionId: streamingIdSchema,
          name: streamingObjectNameSchema,
        }),
        request.params,
      ),
      query = validate(querySchema, request.query);
    reply
      .header("cache-control", "private, no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff");
    if (request.headers.origin) {
      if (!config.allowedOrigins.includes(request.headers.origin))
        throw new ApiError(403, "ORIGIN_FORBIDDEN", "This playback origin is not allowed");
      reply
        .header("access-control-allow-origin", request.headers.origin)
        .header("vary", "Origin")
        .header("access-control-expose-headers", "Content-Range,Accept-Ranges");
    }
    const token =
      query.token ?? /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const grant = verifyStreamingGrant(config.secret, token, "streaming-playback");
    if (
      grant?.action !== "read" ||
      grant.streamId !== params.streamId ||
      grant.sessionId !== params.sessionId
    )
      throw new ApiError(401, "PLAYBACK_GRANT_REQUIRED", "Refresh your playback grant");
    const scheduledAccess = async (db: Transaction) => {
      if (grant.sub.startsWith("sview_")) {
        const [allowed] = await db.execute(
          sql`SELECT g.id FROM schedule_viewer_grant g JOIN broadcast_schedule bs ON bs.id=g.schedule_id JOIN broadcast_run br ON br.id=bs.broadcast_id WHERE g.id=${grant.sub} AND g.token_hash=${streamingSecretHash(token)} AND g.revoked_at IS NULL AND g.expires_at>now() AND g.epoch=bs.grant_epoch AND bs.state='running' AND br.desired_state='running' AND br.source_session_id=${params.sessionId} AND bs.stream_id=${params.streamId} AND bs.starts_at-make_interval(secs=>bs.viewer_early_seconds)<=now() AND bs.ends_at>now()`,
        );
        if (!allowed)
          throw new ApiError(
            410,
            "SCHEDULE_GRANT_REVOKED",
            "The scheduled event is no longer available.",
          );
      }
    };
    const data = await database.transaction(async (db) => {
      await scheduledAccess(db);
      const stream = await getStream(db, params.streamId);
      const [session] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, params.sessionId));
      if (
        stream.status !== "active" ||
        stream.playbackEpoch !== grant.generation ||
        session?.streamId !== stream.id ||
        session.desiredState !== "running" ||
        ["ended", "failed"].includes(session.state)
      )
        throw new ApiError(410, "PLAYBACK_ENDED", "This playback session is no longer available");
      return { stream, session };
    });
    const version = /^g(\d+)_(.+)$/u.exec(params.name),
      generation = version ? Number(version[1]) : data.session.generation,
      name = version?.[2] ?? params.name;
    validate(streamingObjectNameSchema, name);
    const search = new URLSearchParams();
    for (const key of ["_HLS_msn", "_HLS_part", "_HLS_skip"] as const)
      if (query[key] !== undefined) search.set(key, String(query[key]));
    let body = await origin.media(
      data.stream,
      data.session,
      name,
      generation,
      search.size ? `?${search}` : "",
    );
    if (name.endsWith("m3u8")) {
      const text = body.toString();
      if (!text.startsWith("#EXTM3U") || text.includes("#EXT-X-KEY"))
        throw new ApiError(
          502,
          "INVALID_PLAYLIST",
          "The packager returned an unsupported playlist",
        );
      const uri = (value: string) => {
        const child = validate(streamingObjectNameSchema, value);
        return `g${String(generation)}_${child}?token=${encodeURIComponent(token)}`;
      };
      // Commit advertised complete objects before publishing their references. Preload hints
      // remain live, authenticated requests; they are committed when the part completes.
      for (const child of childNames(text))
        if (!child.endsWith("m3u8"))
          await origin.media(data.stream, data.session, child, generation);
      body = Buffer.from(
        text
          .split(/\r?\n/u)
          .map((line) =>
            line.startsWith("#")
              ? line.replace(/URI="([^"]+)"/gu, (_m: string, v: string) => `URI="${uri(v)}"`)
              : line
                ? uri(line.trim())
                : line,
          )
          .join("\n"),
      );
    }
    // Recheck revocation after blocking LL-HLS reload/storage work.
    const [stillAllowed] = await database.execute(
      sql`SELECT t.id FROM streaming_stream t JOIN streaming_session s ON s.stream_id=t.id WHERE t.id=${params.streamId} AND s.id=${params.sessionId} AND t.status='active' AND t.playback_epoch=${grant.generation} AND s.desired_state='running'`,
    );
    if (!stillAllowed || grant.exp <= Date.now() / 1000)
      throw new ApiError(401, "PLAYBACK_GRANT_EXPIRED", "Refresh your playback grant");
    reply.type(contentType(name));
    if (request.headers.range && !name.endsWith("m3u8")) {
      const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range);
      if (!range)
        return reply
          .code(416)
          .header("content-range", `bytes */${String(body.length)}`)
          .send();
      const start = Number(range[1]),
        end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start > end || start >= body.length)
        return reply
          .code(416)
          .header("content-range", `bytes */${String(body.length)}`)
          .send();
      reply
        .code(206)
        .header("content-range", `bytes ${String(start)}-${String(end)}/${String(body.length)}`);
      body = body.subarray(start, end + 1);
    }
    await database.transaction(scheduledAccess);
    return reply.header("accept-ranges", "bytes").send(body);
  });
  return Promise.resolve();
};

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
