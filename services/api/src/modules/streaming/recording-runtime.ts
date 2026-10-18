import { effectiveBufferPolicy } from "./dvr-service.js";
import { timingSafeEqual } from "node:crypto";
import {
  signStreamingGrant,
  verifyStreamingGrant,
  streamingSecretHash,
} from "@relayrtc/protocol/streaming-control";
import { streamingObjectNameSchema } from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { getStream, secret, type Transaction } from "./repository.js";
import type { StreamingRoutesOptions } from "./routes.js";
import {
  getRecording,
  recordingRowSchema,
  recordingEvent,
  setRecordingState,
  type RecordingRow,
} from "./recording-service.js";
import { StreamingOrigin } from "./playback.js";
import { StreamingStore } from "./store.js";

export const recordingRuntimeRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (
  app,
  { database, config },
) => {
  const store = new StreamingStore(config),
    origin = new StreamingOrigin(database, config);
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 8388608 },
    (_request, body, done) => {
      done(null, body);
    },
  );
  const bearer = (request: FastifyRequest) =>
    request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
  const token = (r: RecordingRow) =>
    signStreamingGrant(
      config.secret,
      {
        aud: "streaming-recording",
        sub: r.lease_token ?? "",
        streamId: r.stream_id,
        sessionId: r.id,
        generation: r.fence,
        action: r.state === "finalizing" ? "finalize" : "capture",
      },
      40,
    );
  const leased = async (db: Transaction, request: FastifyRequest, lock = false) => {
    const claims = verifyStreamingGrant(config.secret, bearer(request), "streaming-recording");
    if (!claims)
      throw new ApiError(401, "RECORDING_LEASE_REQUIRED", "A current recording lease is required.");
    const r = await getRecording(db, claims.sessionId, false, lock);
    if (
      r.fence !== claims.generation ||
      r.stream_id !== claims.streamId ||
      r.lease_token !== claims.sub ||
      !r.leased_until ||
      r.leased_until.getTime() <= Date.now() ||
      !["queued", "recording", "finalizing"].includes(r.state) ||
      claims.action !== (r.state === "finalizing" ? "finalize" : "capture")
    )
      throw new ApiError(
        409,
        "RECORDING_LEASE_EXPIRED",
        "The recording lease is no longer current.",
      );
    return r;
  };
  const put = async (request: FastifyRequest, r: RecordingRow, name: string, body: Buffer) => {
    const digest = streamingSecretHash(body),
      key = `streaming/recordings/${r.project_id}/${r.environment_id}/${r.id}/${name}`;
    const exists = await database.transaction(async (db) => {
      await leased(db, request, true);
      const [size] = await db.execute(
        sql`SELECT coalesce(sum(size_bytes),0)::bigint AS n FROM recording_object WHERE recording_id=${r.id} AND name<>${name}`,
      );
      if (Number(size?.n) + body.length > config.maxRecordingBytes)
        throw new ApiError(
          413,
          "RECORDING_STORAGE_LIMIT",
          "The recording storage limit has been reached.",
        );
      await db.execute(
        sql`INSERT INTO recording_object(recording_id,name,object_key,sha256,size_bytes,fence) VALUES(${r.id},${name},${key},${digest},${body.length},${String(r.fence)}) ON CONFLICT DO NOTHING`,
      );
      const [object] = await db.execute(
        sql`SELECT * FROM recording_object WHERE recording_id=${r.id} AND name=${name} FOR UPDATE`,
      );
      if (object?.sha256 !== digest) throw new Error("RECORDING_IMMUTABLE_OBJECT_CONFLICT");
      return !!object.committed_at;
    });
    if (exists) return;
    await store.put(key, body);
    await database.transaction(async (db) => {
      await leased(db, request, true);
      const changed = await db.execute(
        sql`UPDATE recording_object SET committed_at=now(),metered_at=now() WHERE recording_id=${r.id} AND name=${name} AND committed_at IS NULL RETURNING size_bytes`,
      );
      if (changed.length)
        await db.execute(
          sql`UPDATE recording SET storage_byte_seconds=storage_byte_seconds+stored_bytes*greatest(0,EXTRACT(EPOCH FROM now()-storage_metered_at)),storage_metered_at=now(),stored_bytes=stored_bytes+${body.length} WHERE id=${r.id}`,
        );
    });
  };
  app.post("/internal/v1/recordings/claim", async (request) => {
    const supplied = Buffer.from(bearer(request)),
      expected = Buffer.from(config.workerKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "WORKER_AUTH_REQUIRED", "Worker authentication is required.");
    const input = validate(
      z
        .object({
          workerId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
          allowFinalize: z.boolean().default(true),
          allowCapture: z.boolean().default(true),
        })
        .strict(),
      request.body,
    );
    return database.transaction(async (db) => {
      const [value] = await db.execute(
        sql`SELECT r.* FROM recording r JOIN streaming_stream s ON s.id=r.stream_id WHERE r.state IN ('queued','recording','finalizing') AND (r.state='finalizing' OR (r.stop_requested=false AND r.kind<>'clip')) AND r.lease_token IS NULL AND r.attempts<5 AND r.next_attempt_at<=now() AND s.status='active' AND (r.state<>'finalizing' OR ${input.allowFinalize}) AND (r.state='finalizing' OR ${input.allowCapture}) ORDER BY CASE WHEN r.state='finalizing' THEN 0 ELSE 1 END,r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
      );
      if (!value) return { job: null };
      const [updated] = await db.execute(
        sql`UPDATE recording SET fence=fence+1,attempts=attempts+1,lease_token=${secret()},leased_until=now()+interval '30 seconds',heartbeat_at=now(),worker_id=${input.workerId} WHERE id=${String(value.id)} RETURNING *`,
      );
      const r = recordingRowSchema.parse(updated);
      return {
        job: {
          id: r.id,
          kind: r.state === "finalizing" ? "finalize" : "capture",
          fence: r.fence,
          token: token(r),
          exportMp4: r.policy.exportMp4,
          clip:
            r.kind === "clip"
              ? (
                  await db.execute(
                    sql`SELECT cut_mode,requested_start_seconds-resolved_start_seconds AS offset,requested_end_seconds-requested_start_seconds AS duration FROM clip_request WHERE recording_id=${r.id}`,
                  )
                )[0]
              : null,
          maxBytes: Math.floor(config.maxRecordingBytes / 2),
        },
      };
    });
  });
  app.post("/internal/v1/recordings/heartbeat", (request) =>
    database.transaction(async (db) => {
      const r = await leased(db, request, true);
      await db.execute(
        sql`UPDATE recording SET processing_seconds=processing_seconds+${r.state === "finalizing" ? Math.min(15, Math.max(0, (Date.now() - (r.heartbeat_at?.getTime() ?? Date.now())) / 1000)) : 0},heartbeat_at=now(),leased_until=now()+interval '30 seconds' WHERE id=${r.id}`,
      );
      return { token: token(r), stop: r.stop_requested && r.state !== "finalizing" };
    }),
  );
  app.post("/internal/v1/recordings/release", (request) =>
    database.transaction(async (db) => {
      const r = await leased(db, request, true);
      await db.execute(
        sql`UPDATE recording SET lease_token=NULL,leased_until=NULL,worker_id=NULL WHERE id=${r.id}`,
      );
      return { released: true };
    }),
  );
  app.post("/internal/v1/recordings/fail", (request) =>
    database.transaction(async (db) => {
      const r = await leased(db, request, true);
      await db.execute(
        sql`UPDATE recording SET lease_token=NULL,leased_until=NULL,worker_id=NULL,partial=partial OR ${r.state !== "finalizing"},last_error='RECORDING_WORKER_FAILED',next_attempt_at=now()+interval '5 seconds' WHERE id=${r.id}`,
      );
      return { retry: true };
    }),
  );
  app.post("/internal/v1/recordings/capture", async (request) => {
    const r = await database.transaction((db) => leased(db, request));
    if (r.state === "finalizing") throw new ApiError(409, "CAPTURE_ENDED", "Capture has ended.");
    if (r.stop_requested) return { stop: true };
    const source = await database.transaction(async (db) => {
      const stream = await getStream(db, r.stream_id);
      const [run] = await db.execute(
        sql`SELECT source_session_id,source_generation FROM broadcast_run WHERE id=${r.broadcast_id} AND desired_state='running'`,
      );
      if (!run?.source_session_id) return null;
      const [row] = await db.execute(
        sql`SELECT * FROM streaming_session WHERE id=${z.string().parse(run.source_session_id)} AND generation=${Number(run.source_generation)} AND state='live' AND desired_state='running' AND leased_until>now()`,
      );
      if (!row) return null;
      const { schema } = await import("@relayrtc/database");
      const { eq } = await import("drizzle-orm");
      const [session] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, String(row.id)));
      return session ? { stream, session } : null;
    });
    if (!source) return { stop: false, waiting: true };
    const readPlaylist = async (name: string) =>
      (
        await origin.media(source.stream, source.session, name, source.session.generation)
      ).toString();
    let playlist = await readPlaylist("index.m3u8");
    let audioPlaylist: string | null = null;
    if (playlist.includes("#EXT-X-STREAM-INF")) {
      const child = streamingObjectNameSchema.parse(
        playlist.split(/\r?\n/u).find((line) => line && !line.startsWith("#")),
      );
      const rendition = playlist
        .split(/\r?\n/u)
        .find(
          (line) =>
            line.startsWith("#EXT-X-MEDIA:") &&
            line.includes("TYPE=AUDIO") &&
            line.includes("URI="),
        );
      const audioName = rendition
        ? streamingObjectNameSchema.parse(/URI="([^"]+)"/u.exec(rendition)?.[1])
        : null;
      if (audioName && audioName !== child) audioPlaylist = await readPlaylist(audioName);
      playlist = await readPlaylist(child);
    }
    const parsePlaylist = (playlist: string) => {
      if (!playlist.startsWith("#EXTM3U") || playlist.includes("#EXT-X-KEY"))
        throw new Error("RECORDING_UNSUPPORTED_PLAYLIST");
      let sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/u.exec(playlist)?.[1] ?? 0),
        duration = 0,
        init = "",
        pdt: string | null = null,
        discontinuity = false,
        missing = false;
      const segments: {
        sequence: number;
        duration: number;
        name: string;
        init: string;
        pdt: string | null;
        discontinuity: boolean;
      }[] = [];
      for (const line of playlist.split(/\r?\n/u)) {
        if (line.startsWith("#EXT-X-MAP:"))
          init = streamingObjectNameSchema.parse(/URI="([^"]+)"/u.exec(line)?.[1]);
        else if (line.startsWith("#EXTINF:")) duration = Number(line.slice(8).split(",")[0]);
        else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))
          pdt = new Date(line.slice(25)).toISOString();
        else if (line === "#EXT-X-DISCONTINUITY") discontinuity = true;
        else if (line === "#EXT-X-GAP") missing = true;
        else if (line && !line.startsWith("#")) {
          if (init && duration > 0 && duration <= 30 && !missing)
            segments.push({
              sequence,
              duration,
              name: streamingObjectNameSchema.parse(line),
              init,
              pdt,
              discontinuity,
            });
          sequence++;
          duration = 0;
          missing = false;
          discontinuity = false;
          pdt = null;
        }
      }
      return segments;
    };
    const segments = parsePlaylist(playlist),
      audioSegments = audioPlaylist ? parsePlaylist(audioPlaylist) : null;
    const same =
      r.source_session_id === source.session.id &&
      r.source_generation === source.session.generation;
    const candidates = (
      same ? segments.filter((s) => s.sequence > (r.source_sequence ?? -1)) : segments.slice(-2)
    ).slice(0, 3);
    for (const segment of candidates) {
      const audio = audioSegments?.find((part) => part.sequence === segment.sequence);
      if (audioSegments && !audio) break;
      let audioName: string | null = null,
        audioInitName: string | null = null;
      const additional = new Map<string, Buffer>();
      if (audio) {
        const audioBody = await origin.media(
          source.stream,
          source.session,
          audio.name,
          source.session.generation,
        );
        const audioInit = await origin.media(
          source.stream,
          source.session,
          audio.init,
          source.session.generation,
        );
        audioName = `seg_${streamingSecretHash(`${source.session.id}:${String(source.session.generation)}:${String(segment.sequence)}:audio`)}.m4s`;
        audioInitName = `init_${streamingSecretHash(audioInit)}.mp4`;
        additional.set(audioName, audioBody);
        additional.set(audioInitName, audioInit);
      }
      const initBody = await origin.media(
        source.stream,
        source.session,
        segment.init,
        source.session.generation,
      );
      const body = await origin.media(
        source.stream,
        source.session,
        segment.name,
        source.session.generation,
      );
      const initName = `init_${streamingSecretHash(initBody)}.mp4`,
        name = `seg_${streamingSecretHash(`${source.session.id}:${String(source.session.generation)}:${String(segment.sequence)}`)}.m4s`;
      additional.set(initName, initBody);
      additional.set(name, body);
      const names = [...additional.keys()];
      const [allocated] = await database.execute(
        sql`SELECT coalesce(sum(size_bytes),0)::bigint AS bytes,coalesce(sum(size_bytes) FILTER(WHERE name=ANY(ARRAY[${sql.join(
          names.map((name) => sql`${name}`),
          sql`, `,
        )}]::text[])),0)::bigint AS existing FROM recording_object WHERE recording_id=${r.id}`,
      );
      const bufferCap =
        r.kind === "buffer"
          ? (await database.transaction((db) => effectiveBufferPolicy(db, r.stream_id, r.id)))
              .maxBytes
          : config.maxRecordingBytes;
      const captureBudget =
        r.kind === "buffer"
          ? Math.min(bufferCap, config.maxRecordingBytes) - 1048576
          : r.policy.exportMp4
            ? Math.floor(config.maxRecordingBytes / 2) - 1048576
            : config.maxRecordingBytes - 1048576;
      if (
        Number(allocated?.bytes) +
          [...additional.values()].reduce((total, value) => total + value.length, 0) -
          Number(allocated?.existing) >
        captureBudget
      ) {
        await database.transaction(async (db) => {
          await leased(db, request, true);
          await db.execute(
            sql`UPDATE recording SET stop_requested=stop_requested OR ${r.kind !== "buffer"},partial=partial OR ${r.kind === "buffer"},last_error=${r.kind === "buffer" ? "BUFFER_STORAGE_PRESSURE" : "RECORDING_STORAGE_LIMIT"} WHERE id=${r.id}`,
          );
        });
        // Pins win over capture. Retry after eviction frees space, without exceeding the cap.
        return { stop: r.kind !== "buffer", committed: 0 };
      }
      for (const [objectName, objectBody] of additional)
        await put(request, r, objectName, objectBody);
      await database.transaction(async (db) => {
        let current = await leased(db, request, true);
        const previous =
          current.source_session_id === source.session.id &&
          current.source_generation === source.session.generation;
        const gap =
          current.segment_count > 0 &&
          (!previous || segment.sequence !== (current.source_sequence ?? -1) + 1);
        const inserted = await db.execute(
          sql`INSERT INTO recording_segment(recording_id,position,session_id,generation,sequence,name,init_name,audio_name,audio_init_name,audio_duration_seconds,duration_seconds,program_date_time,discontinuity,media_start_seconds) SELECT ${r.id},${current.segment_count},${source.session.id},${String(source.session.generation)},${String(segment.sequence)},${name},${initName},${audioName},${audioInitName},${audio?.duration ?? null},${segment.duration},${segment.pdt},${segment.discontinuity || !!audio?.discontinuity || gap},${current.duration_seconds} WHERE EXISTS(SELECT 1 FROM recording_object WHERE recording_id=${r.id} AND name=${name} AND committed_at IS NOT NULL) AND EXISTS(SELECT 1 FROM recording_object WHERE recording_id=${r.id} AND name=${initName} AND committed_at IS NOT NULL) AND (${audioName}::text IS NULL OR EXISTS(SELECT 1 FROM recording_object WHERE recording_id=${r.id} AND name=${audioName} AND committed_at IS NOT NULL)) AND (${audioInitName}::text IS NULL OR EXISTS(SELECT 1 FROM recording_object WHERE recording_id=${r.id} AND name=${audioInitName} AND committed_at IS NOT NULL)) ON CONFLICT DO NOTHING RETURNING position`,
        );
        if (!inserted.length) return;
        const [updated] = await db.execute(
          sql`UPDATE recording SET source_session_id=${source.session.id},source_generation=${String(source.session.generation)},source_sequence=${String(segment.sequence)},segment_count=segment_count+1,last_error=CASE WHEN last_error='BUFFER_STORAGE_PRESSURE' THEN NULL ELSE last_error END,duration_seconds=duration_seconds+${segment.duration},partial=partial OR ${gap},started_at=coalesce(started_at,now()) WHERE id=${r.id} RETURNING *`,
        );
        current = recordingRowSchema.parse(updated);
        current = await setRecordingState(db, current, "recording");
        if (current.kind === "recording" && current.policy.segmentEvents)
          await recordingEvent(db, current, "recording.segment_committed", {
            position: current.segment_count - 1,
            durationSeconds: segment.duration,
          });
        if (current.duration_seconds >= current.policy.maxDurationSeconds)
          await db.execute(sql`UPDATE recording SET stop_requested=true WHERE id=${r.id}`);
      });
    }
    return { stop: false, committed: candidates.length };
  });
  const manifest = async (r: RecordingRow, name = "index.m3u8") => {
    const rows = await database.execute(
      sql`SELECT * FROM recording_segment WHERE recording_id=${r.id} ORDER BY position`,
    );
    if (!rows.length) throw new Error("RECORDING_NO_MEDIA");
    const split = rows.some((row) => row.audio_name !== null);
    if (split && rows.some((row) => row.audio_name === null))
      throw new Error("RECORDING_INCOMPATIBLE_TRACK_LAYOUT");
    if (split && name === "index.m3u8")
      return Buffer.from(
        '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="program-audio",NAME="Program",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=10000000,AUDIO="program-audio"\nvideo.m3u8\n',
      );
    if (name === "audio.m3u8" && !split) throw new Error("RECORDING_AUDIO_NOT_FOUND");
    const parts = rows.map((row) => ({
      ...row,
      discontinuity: row.discontinuity,
      program_date_time: row.program_date_time,
      name: name === "audio.m3u8" ? row.audio_name : row.name,
      init_name: name === "audio.m3u8" ? row.audio_init_name : row.init_name,
      duration_seconds: name === "audio.m3u8" ? row.audio_duration_seconds : row.duration_seconds,
    }));

    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${String(Math.ceil(Math.max(...parts.map((s) => Number(s.duration_seconds)))))}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
    ];
    let init = "";
    for (const segment of parts) {
      if (segment.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
      if (init !== segment.init_name) {
        init = String(segment.init_name);
        lines.push(`#EXT-X-MAP:URI="${init}"`);
      }
      if (segment.program_date_time)
        lines.push(
          `#EXT-X-PROGRAM-DATE-TIME:${z.coerce.date().parse(segment.program_date_time).toISOString()}`,
        );
      lines.push(`#EXTINF:${String(segment.duration_seconds)},`, String(segment.name));
    }
    lines.push("#EXT-X-ENDLIST", "");
    return Buffer.from(lines.join("\n"));
  };
  app.get("/internal/v1/recordings/media/:name", async (request, reply) => {
    const r = await database.transaction((db) => leased(db, request));
    if (r.state !== "finalizing")
      throw new ApiError(409, "FINALIZATION_REQUIRED", "Finalization is required.");
    const { name } = validate(z.object({ name: streamingObjectNameSchema }), request.params);
    let body: Buffer;
    if (["index.m3u8", "video.m3u8", "audio.m3u8"].includes(name)) body = await manifest(r, name);
    else {
      const [object] = await database.execute(
        sql`SELECT object_key FROM recording_object WHERE recording_id=${r.id} AND name=${name} AND committed_at IS NOT NULL AND name NOT LIKE 'export_%'`,
      );
      if (!object) throw new ApiError(404, "MEDIA_NOT_FOUND", "Media not found.");
      body = await store.get(String(object.object_key));
    }
    await database.transaction((db) => leased(db, request));
    return reply
      .type(name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4")
      .send(body);
  });
  app.post("/internal/v1/recordings/upload/:name", { bodyLimit: 8388608 }, async (request) => {
    const r = await database.transaction((db) => leased(db, request));
    const { name } = validate(
      z.object({
        name: z
          .string()
          .regex(
            /^export_(?:part_\d{1,5}\.bin|thumb\.jpg|render(?:_init\.mp4|_seg_\d{5}\.m4s|\.m3u8))$/u,
          ),
      }),
      request.params,
    );
    if (r.state !== "finalizing" || !Buffer.isBuffer(request.body))
      throw new ApiError(400, "INVALID_EXPORT", "A finalization upload is required.");
    if (name.includes("render") && r.kind !== "clip")
      throw new ApiError(400, "INVALID_EXPORT", "Clip package required.");
    let body: Buffer = request.body;
    if (name === "export_render.m3u8") {
      const playlist = body.toString();
      if (
        !playlist.startsWith("#EXTM3U") ||
        playlist.includes("#EXT-X-KEY") ||
        !playlist.includes("#EXT-X-ENDLIST")
      )
        throw new Error("CLIP_INVALID_MANIFEST");
      for (const line of playlist.split(/\r?\n/u)) {
        if (line && !line.startsWith("#") && !/^render_seg_\d{5}\.m4s$/u.test(line))
          throw new Error("CLIP_INVALID_MANIFEST");
        for (const match of line.matchAll(/URI="([^"]+)"/gu))
          if (match[1] !== "render_init.mp4") throw new Error("CLIP_INVALID_MANIFEST");
      }
      body = Buffer.from(
        playlist.replace(
          /render_(?:init\.mp4|seg_\d{5}\.m4s)/gu,
          (value) => `export_${String(r.fence)}_${value}`,
        ),
      );
    }
    await put(request, r, name.replace("export_", `export_${String(r.fence)}_`), body);
    return { uploaded: true };
  });
  app.post("/internal/v1/recordings/complete", async (request) => {
    const input = validate(
      z
        .object({
          parts: z.number().int().min(0).max(128),
          thumbnail: z.boolean(),
          codecs: z.array(z.enum(["h264", "aac"])).max(2),
          duration: z.number().positive().max(86460),
        })
        .strict(),
      request.body,
    );
    const r = await database.transaction((db) => leased(db, request));
    if (
      r.state !== "finalizing" ||
      (r.policy.exportMp4 && input.parts < 1) ||
      Math.abs(input.duration - r.duration_seconds) >
        (r.kind === "clip"
          ? Math.max(0.5, r.duration_seconds * 0.01)
          : Math.max(10, r.duration_seconds * 0.05))
    )
      throw new ApiError(
        409,
        "INVALID_FINALIZED_MEDIA",
        "Export metadata does not match recorded media.",
      );
    let body: Buffer;
    if (r.kind === "clip") {
      const [object] = await database.execute(
        sql`SELECT object_key FROM recording_object WHERE recording_id=${r.id} AND name=${`export_${String(r.fence)}_render.m3u8`} AND committed_at IS NOT NULL`,
      );
      if (!object) throw new Error("CLIP_PACKAGE_MISSING");
      body = await store.get(String(object.object_key));
      const refs = [
        ...body.toString().matchAll(/export_\d+_render_(?:init\.mp4|seg_\d{5}\.m4s)/gu),
      ].map((m) => m[0]);
      if (!refs.length) throw new Error("CLIP_PACKAGE_MISSING");
      for (const ref of new Set(refs)) {
        const [part] = await database.execute(
          sql`SELECT name FROM recording_object WHERE recording_id=${r.id} AND name=${ref} AND committed_at IS NOT NULL`,
        );
        if (!part) throw new Error("CLIP_PACKAGE_MISSING");
      }
    } else body = await manifest(r);
    if (body.toString().includes("#EXT-X-STREAM-INF")) {
      await put(request, r, `vod_${String(r.fence)}_video.m3u8`, await manifest(r, "video.m3u8"));
      await put(request, r, `vod_${String(r.fence)}_audio.m3u8`, await manifest(r, "audio.m3u8"));
    }
    await put(request, r, `vod_${String(r.fence)}.m3u8`, body);
    return database.transaction(async (db) => {
      const current = await leased(db, request, true);
      for (let index = 0; index < input.parts; index++) {
        const [part] = await db.execute(
          sql`SELECT name FROM recording_object WHERE recording_id=${r.id} AND name=${`export_${String(r.fence)}_part_${String(index)}.bin`} AND committed_at IS NOT NULL`,
        );
        if (!part) throw new Error("EXPORT_PART_MISSING");
      }
      if (input.thumbnail) {
        const [thumbnail] = await db.execute(
          sql`SELECT name FROM recording_object WHERE recording_id=${r.id} AND name=${`export_${String(r.fence)}_thumb.jpg`} AND committed_at IS NOT NULL`,
        );
        if (!thumbnail) throw new Error("EXPORT_THUMBNAIL_MISSING");
      }
      if (current.partial && !current.policy.allowPartial)
        throw new Error("RECORDING_PARTIAL_NOT_ALLOWED");
      const [row] = await db.execute(
        sql`UPDATE recording SET export_fence=${String(r.fence)},mp4_parts=${input.parts},has_thumbnail=${input.thumbnail},codecs=${JSON.stringify(input.codecs)}::jsonb,expires_at=now()+make_interval(secs=>${r.policy.retentionSeconds}),ended_at=coalesce(ended_at,now()),lease_token=NULL,leased_until=NULL,worker_id=NULL WHERE id=${r.id} RETURNING *`,
      );
      if (r.kind === "clip")
        await db.execute(sql`DELETE FROM recording_segment WHERE recording_id=${r.id}`);
      await setRecordingState(db, recordingRowSchema.parse(row), "ready");
      return { ready: true };
    });
  });
  return Promise.resolve();
};
