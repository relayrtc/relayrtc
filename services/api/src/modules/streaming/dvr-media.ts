import { sql } from "drizzle-orm";
import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { verifyStreamingGrant } from "@relayrtc/protocol/streaming-control";
import { streamingIdSchema, streamingObjectNameSchema } from "@relayrtc/validation";
import { validate } from "../../http/validation/validate.js";
import { ApiError } from "../../http/errors/api-error.js";
import { id, type Transaction } from "./repository.js";
import { dvrWindowData } from "./dvr-service.js";
import { StreamingStore } from "./store.js";
import type { StreamingRoutesOptions } from "./routes.js";

export const dvrMediaRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (
  app,
  { database, config },
) => {
  const store = new StreamingStore(config);
  app.get("/v1/dvr/:streamId/:windowId/:name", async (request, reply) => {
    const { streamId, windowId, name } = validate(
      z.object({
        streamId: streamingIdSchema,
        windowId: streamingIdSchema,
        name: streamingObjectNameSchema,
      }),
      request.params,
    );
    const { token } = validate(
      z.object({ token: z.string().min(1).max(4096) }).strict(),
      request.query,
    );
    const isManifest = ["index.m3u8", "video.m3u8", "audio.m3u8"].includes(name);
    const access = async (db: Transaction, includeSegments = false) => {
      const claims = verifyStreamingGrant(config.secret, token, "streaming-playback");
      if (claims?.action !== "dvr" || claims.streamId !== streamId || claims.sessionId !== windowId)
        throw new ApiError(401, "PLAYBACK_GRANT_REQUIRED", "Refresh your playback grant.");
      const [owner] = await db.execute(
        sql`SELECT s.id FROM streaming_stream s JOIN project p ON p.id=s.project_id JOIN environment e ON e.id=s.environment_id JOIN organization o ON o.id=s.organization_id WHERE s.id=${streamId} AND s.playback_epoch=${claims.generation} AND s.status='active' AND p.status='active' AND e.status='active' AND o.status='active'`,
      );
      if (!config.dvrEnabled || !owner)
        throw new ApiError(410, "DVR_ACCESS_REVOKED", "DVR access is no longer available.");
      const data = await dvrWindowData(db, streamId, undefined, windowId, true, includeSegments);
      if (!data || data.expired)
        throw new ApiError(410, "DVR_WINDOW_EXPIRED", "This run's DVR window has expired.");
      return data;
    };
    reply
      .header("cache-control", "private, no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff");
    if (request.headers.origin) {
      if (!config.allowedOrigins.includes(request.headers.origin))
        throw new ApiError(403, "ORIGIN_FORBIDDEN", "This playback origin is not allowed.");
      reply.header("access-control-allow-origin", request.headers.origin).header("vary", "Origin");
    }
    const relative = (value: string) => `${value}?token=${encodeURIComponent(token)}`;
    let objectKey: string | undefined;
    let body: Buffer = await database.transaction(async (db) => {
      const data = await access(db, isManifest),
        segments = data.segments;
      const first = segments[0];
      if (["index.m3u8", "video.m3u8", "audio.m3u8"].includes(name)) {
        if (segments.length)
          await db.execute(
            sql`INSERT INTO dvr_segment_pin(recording_id,position,expires_at) VALUES ${sql.join(
              segments.map(
                (segment) =>
                  sql`(${data.r.id},${Number(segment.position)},now()+interval '60 seconds')`,
              ),
              sql`, `,
            )} ON CONFLICT(recording_id,position) DO UPDATE SET expires_at=greatest(dvr_segment_pin.expires_at,excluded.expires_at)`,
          );
        if (!first) throw new ApiError(409, "DVR_MEDIA_PENDING", "Waiting for retained media.");
        const separateAudio = segments.every((s) => !!s.audio_name);
        if (name === "index.m3u8" && separateAudio)
          return Buffer.from(
            `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${relative("audio.m3u8")}"\n#EXT-X-STREAM-INF:BANDWIDTH=24000000,AUDIO="audio"\n${relative("video.m3u8")}\n`,
          );
        const audio = name === "audio.m3u8";
        if (audio && !separateAudio)
          throw new ApiError(410, "DVR_RANGE_EXPIRED", "This audio range is no longer available.");
        const duration = (s: (typeof segments)[number]) =>
          Number(audio ? s.audio_duration_seconds : s.duration_seconds);
        const lines = [
          "#EXTM3U",
          "#EXT-X-VERSION:7",
          "#EXT-X-TARGETDURATION:6",
          `#EXT-X-MEDIA-SEQUENCE:${String(first.position)}`,
          `#EXT-X-DISCONTINUITY-SEQUENCE:${String(Math.max(0, Number(first.discontinuity_sequence) - (first.discontinuity ? 1 : 0)))}`,
        ];
        let previousMap = "";
        for (const s of segments) {
          if (s.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
          const map = String(audio ? s.audio_init_name : s.init_name);
          if (map !== previousMap) {
            lines.push(`#EXT-X-MAP:URI="${relative(map)}"`);
            previousMap = map;
          }
          if (s.program_date_time)
            lines.push(
              `#EXT-X-PROGRAM-DATE-TIME:${z.coerce.date().parse(s.program_date_time).toISOString()}`,
            );
          lines.push(
            `#EXTINF:${duration(s).toFixed(6)},`,
            relative(String(audio ? s.audio_name : s.name)),
          );
        }
        if (data.window.state === "draining") lines.push("#EXT-X-ENDLIST");
        return Buffer.from(lines.join("\n") + "\n");
      }
      if (!/^(?:seg_[a-f0-9]{64}\.m4s|init_[a-f0-9]{64}\.mp4)$/u.test(name))
        throw new ApiError(404, "DVR_OBJECT_NOT_FOUND", "Media was not found.");
      // A segment must still be advertised, or be held by a recently published playlist.
      const [segment] = await db.execute(
        sql`SELECT s.position FROM recording_segment s WHERE s.recording_id=${data.r.id} AND (s.name=${name} OR s.init_name=${name} OR s.audio_name=${name} OR s.audio_init_name=${name}) AND EXISTS(SELECT 1 FROM dvr_segment_pin p WHERE p.recording_id=s.recording_id AND p.position=s.position AND p.expires_at>now()) LIMIT 1`,
      );
      if (!segment)
        throw new ApiError(
          410,
          "DVR_RANGE_EXPIRED",
          "This seek range has expired. Return to the available window.",
        );
      const [object] = await db.execute(
        sql`SELECT object_key FROM recording_object WHERE recording_id=${data.r.id} AND name=${name} AND committed_at IS NOT NULL`,
      );
      if (!object)
        throw new ApiError(410, "DVR_RANGE_EXPIRED", "This segment is no longer retained.");
      objectKey = String(object.object_key);
      return Buffer.alloc(0);
    });
    if (objectKey) body = await store.get(objectKey);
    await database.transaction((db) => access(db));
    const deliveredBytes = request.method === "HEAD" ? 0 : body.length,
      usageId = id("dvrdelivery");
    // Record origin HTTP payload bytes only after successful server-side completion.
    reply.raw.once("finish", () => {
      if (!reply.raw.writableFinished || reply.statusCode >= 400) return;
      void database
        .transaction(async (db) => {
          const added = await db.execute(
            sql`INSERT INTO dvr_delivery_usage(id,window_id,bytes) VALUES(${usageId},${windowId},${deliveredBytes}) ON CONFLICT DO NOTHING RETURNING id`,
          );
          if (added.length)
            await db.execute(
              sql`UPDATE dvr_window SET delivered_bytes=delivered_bytes+${deliveredBytes} WHERE id=${windowId}`,
            );
        })
        .catch((err: unknown) => {
          app.log.error({ err, windowId }, "DVR delivery metering failed");
        });
    });
    return reply
      .type(name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4")
      .send(body);
  });
  return Promise.resolve();
};
