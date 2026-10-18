import type { RelayKitDatabase } from "@relayrtc/database";
import type { MixerResource, MixerOperation } from "@relayrtc/types";
import { mixerSceneSchema } from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { id, missing, conflict, type Transaction, type SessionRow } from "./repository.js";
import type { StreamingConfig } from "./config.js";
import { StreamingStore } from "./store.js";

export const mixerRowSchema = z.object({
  id: z.string(),
  broadcast_id: z.string(),
  stream_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  state: z.enum(["created", "preparing", "live", "degraded", "stopping", "stopped", "failed"]),
  desired_state: z.enum(["running", "stopped"]),
  version: z.number(),
  desired_version: z.number(),
  applied_version: z.number(),
  desired_scene_id: z.string().nullable(),
  applied_scene_id: z.string().nullable(),
  snapshot: mixerSceneSchema.nullable(),
  applied_snapshot: mixerSceneSchema.nullable(),
  lost_sources: z.array(z.string()),
  last_error: z.string().nullable(),
  render_seconds: z.coerce.number(),
  program_seconds: z.coerce.number(),
  input_seconds: z.coerce.number(),
  frames: z.coerce.number(),
  created_at: z.coerce.date(),
  activated_at: z.coerce.date().nullable(),
  stop_requested_at: z.coerce.date().nullable(),
  ended_at: z.coerce.date().nullable(),
});
export type MixerRow = z.infer<typeof mixerRowSchema>;
export async function getMixer(db: Transaction, key: string, lock = false) {
  const [row] = await db.execute(
    sql`SELECT * FROM mixer WHERE id=${key} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  if (!row) throw missing();
  return mixerRowSchema.parse(row);
}
export async function publicMixer(db: Transaction, m: MixerRow): Promise<MixerResource> {
  const sources = await db.execute(
      sql`SELECT id,stream_id FROM mixer_source WHERE mixer_id=${m.id} ORDER BY id`,
    ),
    overlays = await db.execute(
      sql`SELECT id,name,width,height,size_bytes FROM mixer_overlay WHERE mixer_id=${m.id} AND state='ready' ORDER BY id`,
    );
  return {
    id: m.id,
    broadcastId: m.broadcast_id,
    streamId: m.stream_id,
    projectId: m.project_id,
    environmentId: m.environment_id,
    state: m.state,
    version: m.version,
    desiredVersion: m.desired_version,
    appliedVersion: m.applied_version,
    desiredSceneId: m.desired_scene_id,
    appliedSceneId: m.applied_scene_id,
    sources: sources.map((s) => ({ id: String(s.id), streamId: String(s.stream_id) })),
    overlays: overlays.map((o) => ({
      id: String(o.id),
      name: String(o.name),
      width: Number(o.width),
      height: Number(o.height),
      sizeBytes: Number(o.size_bytes),
    })),
    lostSources: m.lost_sources,
    lastError: m.last_error,
    usage: {
      renderSeconds: m.render_seconds,
      programSeconds: m.program_seconds,
      inputSeconds: m.input_seconds,
      frames: m.frames,
    },
    limits: {
      canvasWidth: 640,
      canvasHeight: 360,
      fps: 15,
      maxInputs: 4,
      maxLayers: 12,
      gpu: false,
    },
    createdAt: m.created_at.toISOString(),
    endedAt: m.ended_at?.toISOString() ?? null,
  };
}
export async function mixerOperation(db: Transaction, key: string): Promise<MixerOperation> {
  const [o] = await db.execute(sql`SELECT * FROM mixer_operation WHERE id=${key}`);
  if (!o) throw missing();
  return z
    .object({
      id: z.string(),
      mixerId: z.string(),
      kind: z.enum(["activate", "stop"]),
      revision: z.number(),
      status: z.enum(["pending", "completed", "failed"]),
      errorCode: z.string().nullable(),
      createdAt: z.string(),
      completedAt: z.string().nullable(),
    })
    .parse({
      id: o.id,
      mixerId: o.mixer_id,
      kind: o.kind,
      revision: o.revision,
      status: o.status,
      errorCode: o.error_code,
      createdAt: z.coerce.date().parse(o.created_at).toISOString(),
      completedAt: o.completed_at ? z.coerce.date().parse(o.completed_at).toISOString() : null,
    });
}
export async function mixerEvent(
  db: Transaction,
  m: MixerRow,
  type: string,
  details: Record<string, unknown> = {},
) {
  const [seq] = await db.execute(
      sql`UPDATE mixer SET event_sequence=event_sequence+1 WHERE id=${m.id} RETURNING event_sequence`,
    ),
    eventId = id("event"),
    occurredAt = new Date().toISOString();
  const body = JSON.stringify({
    id: eventId,
    type,
    projectId: m.project_id,
    environmentId: m.environment_id,
    occurredAt,
    data: {
      mixerId: m.id,
      streamId: m.stream_id,
      broadcastId: m.broadcast_id,
      state: m.state,
      desiredVersion: m.desired_version,
      appliedVersion: m.applied_version,
      sequence: Number(seq?.event_sequence),
      actor: { type: "SYSTEM", id: "mixer-runtime", name: "Mixer runtime" },
      ...details,
    },
  });
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${m.project_id},${m.environment_id},${type},${occurredAt},${body}::jsonb,${body})`,
  );
}
export async function validateMixerScene(
  db: Transaction,
  m: MixerRow,
  scene: z.infer<typeof mixerSceneSchema>,
) {
  if (m.desired_state !== "running" || ["stopping", "stopped", "failed"].includes(m.state))
    throw conflict("MIXER_STOPPED", "Create a new mixer for a stopped run.");
  const sources = await db.execute(sql`SELECT id FROM mixer_source WHERE mixer_id=${m.id}`),
    allowed = new Set(sources.map((s) => String(s.id)));
  if ([...scene.layers, ...scene.audio].some((s) => !allowed.has(s.sourceId)))
    throw conflict("MIXER_SOURCE_UNBOUND", "Choose registered source IDs.");
  if (
    (scene.layout === "single" && scene.layers.length > 1) ||
    (scene.layout === "pip" && scene.layers.length > 2)
  )
    throw conflict("MIXER_LAYOUT_LIMIT", "This layout has too many video layers.");
  for (const layer of scene.overlays) {
    const [asset] = await db.execute(
      sql`SELECT id FROM mixer_overlay WHERE id=${layer.overlayId} AND mixer_id=${m.id} AND state='ready'`,
    );
    if (!asset)
      throw conflict("MIXER_OVERLAY_UNAVAILABLE", "Use a ready overlay belonging to this mixer.");
  }
}
export async function requestMixerStop(db: Transaction, m: MixerRow, reason: string | null = null) {
  if (["stopped", "failed"].includes(m.state) || m.desired_state === "stopped") return;
  await db.execute(
    sql`UPDATE mixer SET desired_state='stopped',state='stopping',version=version+1,stop_requested_at=coalesce(stop_requested_at,now()),last_error=${reason} WHERE id=${m.id}`,
  );
  await db.execute(
    sql`UPDATE mixer_operation SET status='failed',error_code=${reason ?? "MIXER_STOPPED"},completed_at=now() WHERE mixer_id=${m.id} AND kind='activate' AND status='pending'`,
  );
}
export async function claimMixer(db: Transaction, session: SessionRow, config: StreamingConfig) {
  if (!config.mixersEnabled) return null;
  const [value] = await db.execute(
    sql`SELECT m.* FROM mixer m JOIN broadcast_run b ON b.id=m.broadcast_id WHERE m.stream_id=${session.streamId} AND m.desired_state='running' AND m.snapshot IS NOT NULL AND b.desired_state='running' AND b.state NOT IN ('stopping','stopped','failed') FOR UPDATE OF m`,
  );
  if (!value) return null;
  const m = mixerRowSchema.parse(value);
  await db.execute(
    sql`UPDATE mixer_render_session SET ended_at=coalesce(ended_at,now()) WHERE mixer_id=${m.id} AND ended_at IS NULL`,
  );
  await db.execute(
    sql`INSERT INTO mixer_render_session(mixer_id,session_id,generation) VALUES(${m.id},${session.id},${session.generation})`,
  );
  await db.execute(
    sql`UPDATE mixer SET state='preparing',applied_version=0,applied_scene_id=NULL,applied_snapshot=NULL WHERE id=${m.id}`,
  );
  return m.id;
}
export function registerMixerMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  const store = new StreamingStore(config);
  let running: Promise<void> | undefined;
  const tick = async () => {
    await database.transaction(async (db) => {
      const [lock] = await db.execute(sql`SELECT pg_try_advisory_xact_lock(810040) AS ok`);
      if (!lock?.ok) return;
      const rows = await db.execute(
        sql`SELECT m.* FROM mixer m WHERE m.state NOT IN ('stopped','failed') ORDER BY m.id FOR UPDATE SKIP LOCKED LIMIT 50`,
      );
      for (const row of rows) {
        let m = mixerRowSchema.parse(row);
        const [run] = await db.execute(
            sql`SELECT desired_state,state FROM broadcast_run WHERE id=${m.broadcast_id}`,
          ),
          [owner] = await db.execute(
            sql`SELECT status FROM streaming_stream WHERE id=${m.stream_id}`,
          );
        const pending = await db.execute(
          sql`SELECT id FROM mixer_operation WHERE mixer_id=${m.id} AND status='pending' AND kind='activate' AND created_at<now()-interval '60 seconds'`,
        );
        const [sourceFailure] = await db.execute(
          sql`SELECT id FROM streaming_session WHERE mixer_id=${m.id} AND state='failed' AND last_error='WORKER_RETRY_EXHAUSTED'`,
        );
        if (
          m.desired_state === "running" &&
          (!config.mixersEnabled ||
            pending.length ||
            owner?.status !== "active" ||
            ["stopping", "stopped", "failed"].includes(String(run?.state)))
        ) {
          await requestMixerStop(
            db,
            m,
            pending.length
              ? "MIXER_ACTIVATION_TIMEOUT"
              : !config.mixersEnabled
                ? "MIXERS_DISABLED"
                : sourceFailure
                  ? "MIXER_RENDER_FAILED"
                  : "MIXER_OWNER_STOPPED",
          );
          m = await getMixer(db, m.id);
        }
        if (m.desired_state === "stopped") {
          const [active] = await db.execute(
            sql`SELECT id FROM streaming_session WHERE mixer_id=${m.id} AND state NOT IN ('ended','failed') AND leased_until>now()`,
          );
          if (
            !active &&
            (!m.stop_requested_at || Date.now() - m.stop_requested_at.getTime() > 15000)
          ) {
            await db.execute(
              sql`UPDATE mixer_render_session SET ended_at=coalesce(ended_at,now()) WHERE mixer_id=${m.id}`,
            );
            const failed =
              m.last_error === "MIXER_ACTIVATION_TIMEOUT" || m.last_error === "MIXER_RENDER_FAILED";
            await db.execute(
              sql`UPDATE mixer SET state=${failed ? "failed" : "stopped"},ended_at=now() WHERE id=${m.id}`,
            );
            await db.execute(
              sql`UPDATE mixer_operation SET status='completed',completed_at=now() WHERE mixer_id=${m.id} AND kind='stop' AND status='pending'`,
            );
            await mixerEvent(
              db,
              await getMixer(db, m.id),
              failed ? "mixer.failed" : "mixer.stopped",
            );
          }
        }
      }
      // Historical aggregates survive bounded raw sample/operation retention.
      await db.execute(
        sql`DELETE FROM mixer_usage WHERE (session_id,generation,sequence) IN (SELECT session_id,generation,sequence FROM mixer_usage WHERE created_at<now()-interval '90 days' LIMIT 1000)`,
      );
      await db.execute(
        sql`DELETE FROM mixer_operation WHERE id IN(SELECT id FROM mixer_operation WHERE status<>'pending' AND completed_at<now()-interval '90 days' LIMIT 1000)`,
      );
      await db.execute(
        sql`UPDATE mixer_overlay o SET state='deleting',deletion_requested_at=coalesce(deletion_requested_at,now()) FROM mixer m WHERE m.id=o.mixer_id AND o.state IN ('pending','ready') AND ((o.state='pending' AND o.created_at<now()-interval '1 hour') OR (m.ended_at<now()-interval '1 day'))`,
      );
    });
    const doomed = await database.execute(
      sql`SELECT id,object_key FROM mixer_overlay WHERE state='deleting' AND deletion_requested_at<now()-interval '30 seconds' LIMIT 20`,
    );
    for (const o of doomed) {
      await store.remove(String(o.object_key));
      await database.execute(
        sql`UPDATE mixer_overlay SET state='deleted' WHERE id=${String(o.id)} AND state='deleting'`,
      );
    }
  };
  const timer = setInterval(() => {
    running ??= tick()
      .catch((err: unknown) => {
        app.log.error({ err }, "Mixer maintenance failed");
      })
      .finally(() => {
        running = undefined;
      });
  }, 3000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
