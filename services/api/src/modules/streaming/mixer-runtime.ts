import { schema } from "@relayrtc/database";
import {
  streamingObjectNameSchema,
  streamingIdSchema,
  mixerReportSchema,
} from "@relayrtc/validation";
import { signStreamingGrant } from "@relayrtc/protocol/streaming-control";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { validate } from "../../http/validation/validate.js";
import { leased } from "./runtime-routes.js";
import { getStream, conflict, missing, type Transaction, type SessionRow } from "./repository.js";
import { getMixer, mixerEvent } from "./mixer-service.js";
import type { StreamingRoutesOptions } from "./routes.js";
import { StreamingOrigin } from "./playback.js";
import { StreamingStore } from "./store.js";
import { ingestPath } from "./gateway.js";

export async function observeMixer(
  db: Transaction,
  session: SessionRow,
  report: z.infer<typeof mixerReportSchema> | undefined,
  sequence: number,
  elapsed: number,
  observed: boolean,
) {
  if (!session.mixerId || !report) return;
  const m = await getMixer(db, session.mixerId, true);
  if (m.desired_state !== "running") return;
  const [render] = await db.execute(
    sql`SELECT * FROM mixer_render_session WHERE session_id=${session.id} AND generation=${session.generation} AND mixer_id=${m.id} AND ended_at IS NULL FOR UPDATE`,
  );
  if (!render || Number(render.sequence) >= sequence) return;
  if (report.frames < Number(render.frames) || report.revision > m.desired_version)
    throw conflict("MIXER_REPORT_INVALID", "The render report is stale.");
  const sources = await db.execute(sql`SELECT id FROM mixer_source WHERE mixer_id=${m.id}`),
    allowed = new Set(sources.map((s) => String(s.id)));
  if (report.lostSources.some((s) => !allowed.has(s)))
    throw conflict("MIXER_REPORT_INVALID", "Unknown source report.");
  const seconds = Math.min(10, Math.max(0, elapsed)),
    frames = Math.min(300, report.frames - Number(render.frames));
  await db.execute(
    sql`INSERT INTO mixer_usage(mixer_id,session_id,generation,sequence,render_seconds,program_seconds,input_seconds,frames) VALUES(${m.id},${session.id},${session.generation},${sequence},${frames > 0 ? seconds : 0},${observed ? seconds : 0},${seconds * sources.length},${frames}) ON CONFLICT DO NOTHING`,
  );
  await db.execute(
    sql`UPDATE mixer_render_session SET sequence=${sequence},frames=${report.frames},candidate_revision=${report.revision},candidate_sequence=CASE WHEN candidate_revision<>${report.revision} THEN ${sequence} ELSE candidate_sequence END WHERE session_id=${session.id} AND generation=${session.generation}`,
  );
  const applied =
    observed &&
    frames > 0 &&
    Number(render.candidate_revision) === report.revision &&
    sequence > Number(render.candidate_sequence) &&
    report.revision === m.desired_version &&
    report.sceneId === m.desired_scene_id;
  const changed = applied && m.applied_version !== report.revision;
  const state = applied
    ? report.overloaded || report.lostSources.length
      ? "degraded"
      : "live"
    : m.state;
  await db.execute(
    sql`UPDATE mixer SET render_seconds=render_seconds+${frames > 0 ? seconds : 0},program_seconds=program_seconds+${observed ? seconds : 0},input_seconds=input_seconds+${seconds * sources.length},frames=frames+${frames},state=${state},lost_sources=${JSON.stringify(report.lostSources)}::jsonb,applied_snapshot=CASE WHEN ${applied} THEN snapshot ELSE applied_snapshot END,applied_version=CASE WHEN ${applied} THEN ${report.revision} ELSE applied_version END,applied_scene_id=CASE WHEN ${applied} THEN ${report.sceneId} ELSE applied_scene_id END,last_error=${report.overloaded ? "MIXER_OVERLOADED" : report.preparationFailed ? "MIXER_PREPARATION_FAILED" : report.lostSources.length ? "MIXER_SOURCE_LOST" : null} WHERE id=${m.id}`,
  );
  const next = await getMixer(db, m.id);
  if (changed) {
    if (m.applied_version === 0)
      await mixerEvent(db, next, "mixer.started", {
        sessionId: session.id,
        generation: session.generation,
      });
    await mixerEvent(db, next, "mixer.scene_activated", {
      sceneId: report.sceneId,
      sessionId: session.id,
      generation: session.generation,
    });
    await db.execute(
      sql`UPDATE mixer_operation SET status='completed',completed_at=now() WHERE mixer_id=${m.id} AND kind='activate' AND revision=${report.revision} AND status='pending'`,
    );
  }
  if (report.lostSources.some((s) => !m.lost_sources.includes(s)))
    await mixerEvent(db, next, "mixer.source_lost", { sourceIds: report.lostSources });
  if (report.overloaded && m.last_error !== "MIXER_OVERLOADED")
    await mixerEvent(db, next, "mixer.overloaded");
}

export const mixerRuntimeRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (
  app,
  { database, config },
) => {
  const origin = new StreamingOrigin(database, config),
    store = new StreamingStore(config);
  app.post("/internal/v1/streaming/mixer", (request) =>
    database.transaction(async (db) => {
      validate(z.object({}).strict(), request.body ?? {});
      const { session } = await leased(db, config, request);
      if (!session.mixerId || !config.mixersEnabled) return { mixer: null };
      const m = await getMixer(db, session.mixerId);
      if (m.desired_state !== "running" || !m.snapshot) return { mixer: null };
      const sources = await db.execute(
        sql`SELECT ms.id,ms.stream_id,s.profile FROM mixer_source ms JOIN streaming_stream s ON s.id=ms.stream_id WHERE ms.mixer_id=${m.id}`,
      );
      const primaryUrl = new URL(
        `${config.gatewayRtsp.replace(/\/$/u, "")}/${ingestPath(session.streamId)}`,
      );
      primaryUrl.searchParams.set(
        "token",
        signStreamingGrant(
          config.secret,
          {
            aud: "streaming-gateway",
            sub: session.leaseToken ?? "",
            streamId: session.streamId,
            sessionId: session.id,
            generation: session.generation,
            action: "read",
          },
          30,
        ),
      );
      return {
        mixer: {
          id: m.id,
          revision: m.desired_version,
          sceneId: m.desired_scene_id,
          scene: m.snapshot,
          primaryUrl: primaryUrl.toString(),
          sources: sources.map((s) => ({
            id: String(s.id),
            streamId: String(s.stream_id),
            audioOnly: z.object({ audioOnly: z.boolean() }).parse(s.profile).audioOnly,
          })),
        },
      };
    }),
  );
  app.get("/internal/v1/streaming/mixer-assets/:overlayId", async (request, reply) => {
    const { overlayId } = validate(z.object({ overlayId: streamingIdSchema }), request.params);
    const key = await database.transaction(async (db) => {
      const { session } = await leased(db, config, request);
      if (!session.mixerId) throw missing();
      const m = await getMixer(db, session.mixerId);
      if (m.desired_state !== "running") throw missing();
      const [asset] = await db.execute(
        sql`SELECT object_key FROM mixer_overlay WHERE id=${overlayId} AND mixer_id=${m.id} AND state='ready'`,
      );
      if (!asset) throw missing();
      return String(asset.object_key);
    });
    const body = await store.get(key);
    await database.transaction((db) => leased(db, config, request));
    return reply.type("image/png").header("cache-control", "no-store").send(body);
  });
  app.get("/internal/v1/streaming/mixer-media/:sourceId/:name", async (request, reply) => {
    const { sourceId, name } = validate(
      z.object({ sourceId: streamingIdSchema, name: streamingObjectNameSchema }),
      request.params,
    );
    const attachment = await database.transaction(async (db) => {
      const { session } = await leased(db, config, request);
      if (!session.mixerId || sourceId === "primary") throw missing();
      const m = await getMixer(db, session.mixerId);
      if (m.desired_state !== "running") throw missing();
      const [binding] = await db.execute(
        sql`SELECT stream_id FROM mixer_source WHERE mixer_id=${m.id} AND id=${sourceId}`,
      );
      if (!binding) throw missing();
      const stream = await getStream(db, String(binding.stream_id));
      if (
        stream.status !== "active" ||
        stream.projectId !== m.project_id ||
        stream.environmentId !== m.environment_id
      )
        throw missing();
      const profile = z
        .object({ audioOnly: z.boolean(), width: z.number(), height: z.number(), fps: z.number() })
        .parse(stream.profile);
      if (!profile.audioOnly && (profile.width > 1280 || profile.height > 720 || profile.fps > 30))
        throw conflict("MIXER_SOURCE_PROFILE", "The input exceeds the mixer decode budget.");
      const [source] = await db
        .select()
        .from(schema.streamingSession)
        .where(
          sql`stream_id=${stream.id} AND desired_state='running' AND state='live' AND leased_until>now()`,
        )
        .limit(1);
      if (!source) throw conflict("MIXER_SOURCE_LOST", "The selected source is unavailable.");
      return { stream, source };
    });
    const body = await origin.media(
      attachment.stream,
      attachment.source,
      name,
      attachment.source.generation,
    );
    if (name.endsWith("m3u8")) {
      const playlist = body.toString();
      if (!playlist.startsWith("#EXTM3U") || playlist.includes("#EXT-X-KEY"))
        throw conflict("MIXER_SOURCE_PROFILE", "Unsupported source playlist.");
      for (const line of playlist.split(/\r?\n/u)) {
        if (line && !line.startsWith("#")) streamingObjectNameSchema.parse(line);
        for (const match of line.matchAll(/URI="([^"]+)"/gu))
          streamingObjectNameSchema.parse(match[1]);
      }
    }
    await database.transaction(async (db) => {
      await leased(db, config, request);
      const [current] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, attachment.source.id));
      if (
        current?.generation !== attachment.source.generation ||
        current.desiredState !== "running" ||
        current.state !== "live"
      )
        throw conflict("MIXER_SOURCE_LOST", "The source generation changed.");
    });
    return reply
      .header("cache-control", "no-store")
      .type(name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4")
      .send(body);
  });
  return Promise.resolve();
};
