import { recordAudit } from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import type { RestreamSource, RestreamDetail, RestreamState } from "@relayrtc/types";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { destinationVault } from "./destinations.js";
import { getStream, id, type Transaction } from "./repository.js";
import type { StreamingConfig } from "./config.js";

export type SourceRow = typeof schema.restreamSource.$inferSelect;
export type SourceSessionRow = typeof schema.restreamSession.$inferSelect;
export const sourceContext = (row: Pick<SourceRow, "id" | "version">) =>
  `restream-source:${row.id}:${String(row.version)}`;
export function publicSource(row: SourceRow): RestreamSource {
  return {
    id: row.id,
    streamId: row.streamId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    name: row.name,
    protocol: row.protocol as RestreamSource["protocol"],
    host: row.host,
    profile: "h264_aac",
    redistributionAuthorized: true,
    reconnectBudget: row.reconnectBudget,
    maxDurationSeconds: row.maxDurationSeconds,
    maxBytes: row.maxBytes,
    version: row.version,
    secretConfigured: !!row.encryptedSecret,
    state: row.state as RestreamState,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function sourceDetail(db: Transaction, row: SourceRow): Promise<RestreamDetail> {
  const [session] = await db
    .select()
    .from(schema.restreamSession)
    .where(eq(schema.restreamSession.sourceId, row.id))
    .orderBy(sql`created_at DESC`)
    .limit(1);
  const health = await db.execute<{
    state: RestreamState;
    reason: string | null;
    occurred_at: Date;
  }>(
    sql`SELECT state,reason,occurred_at FROM restream_health WHERE source_id=${row.id} ORDER BY id DESC LIMIT 50`,
  );
  const [usage] = await db.execute(
    sql`SELECT coalesce(sum(fetched_bytes),0) bytes,coalesce(sum(processing_seconds),0) seconds FROM restream_session WHERE source_id=${row.id}`,
  );
  return {
    ...publicSource(row),
    session: session
      ? {
          id: session.id,
          sourceId: session.sourceId,
          kind: session.kind as "probe" | "pull" | "push",
          state: session.state as RestreamState,
          attempts: session.attempts,
          fetchedBytes: session.fetchedBytes,
          processingSeconds: session.processingSeconds,
          lastError: session.lastError,
          createdAt: session.createdAt.toISOString(),
          endedAt: session.endedAt?.toISOString() ?? null,
        }
      : null,
    health: health.map((h) => ({
      state: h.state,
      reason: h.reason,
      occurredAt: new Date(h.occurred_at).toISOString(),
    })),
    usage: {
      fetchedBytes: Number(usage?.bytes ?? 0),
      processingSeconds: Number(usage?.seconds ?? 0),
      coverage: "observed",
    },
  };
}
export async function sourceTransition(
  db: Transaction,
  source: SourceRow,
  state: RestreamState,
  sessionId: string | null,
  reason: string | null = null,
) {
  if (source.state === state && source.lastError === reason) return;
  await db
    .update(schema.restreamSource)
    .set({ state, lastError: reason, updatedAt: new Date() })
    .where(eq(schema.restreamSource.id, source.id));
  await db.execute(
    sql`INSERT INTO restream_health(source_id,session_id,state,reason) VALUES(${source.id},${sessionId},${state},${reason})`,
  );
  await db.execute(
    sql`DELETE FROM restream_health WHERE source_id=${source.id} AND id NOT IN(SELECT id FROM restream_health WHERE source_id=${source.id} ORDER BY id DESC LIMIT 50)`,
  );
  const type = (
    {
      probing: "restream.probing",
      live: "restream.source_connected",
      recovering: "restream.recovering",
      stopped: "restream.stopped",
      failed: "restream.failed",
    } as Record<string, string>
  )[state];
  if (source.state === "live" && state !== "live")
    await sourceEvent(db, source, "restream.source_lost", sessionId, reason);
  if (type) {
    await sourceEvent(db, source, type, sessionId, reason);
    const stream = await getStream(db, source.streamId);
    await recordAudit(db, {
      actor: { type: "SYSTEM", name: "External source runtime" },
      action: type,
      outcome: "SUCCESS",
      organizationId: stream.organizationId,
      resourceType: "restream_source",
      resourceId: source.id,
      ...(sessionId ? { correlationId: sessionId } : {}),
    });
  }
}
async function sourceEvent(
  db: Transaction,
  source: SourceRow,
  type: string,
  sessionId: string | null,
  reason: string | null,
) {
  const eventId = id("event"),
    occurredAt = new Date().toISOString(),
    body = JSON.stringify({
      id: eventId,
      type,
      projectId: source.projectId,
      environmentId: source.environmentId,
      occurredAt,
      data: {
        sourceId: source.id,
        streamId: source.streamId,
        sessionId,
        version: source.version,
        correlationId: sessionId,
        reason,
      },
    });
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${source.projectId},${source.environmentId},${type},${occurredAt},${body}::jsonb,${body})`,
  );
}
export function sourceSecret(
  config: StreamingConfig,
  row: SourceRow,
): { endpoint: string; authorization: string } {
  if (!row.encryptedSecret) throw new Error("SOURCE_SECRET_UNAVAILABLE");
  return JSON.parse(destinationVault(config).decrypt(row.encryptedSecret, sourceContext(row))) as {
    endpoint: string;
    authorization: string;
  };
}
export async function stopSourceSession(
  db: Transaction,
  source: SourceRow,
  reason: string | null = null,
) {
  await db.execute(
    sql`UPDATE restream_session j SET credential_id=(SELECT ingress_credential_id FROM streaming_session s WHERE s.stream_id=j.stream_id AND s.state NOT IN('ended','failed') LIMIT 1) WHERE j.source_id=${source.id} AND j.kind='push' AND j.ended_at IS NULL`,
  );
  await db.execute(
    sql`UPDATE restream_session SET desired_state='stopped',last_error=${reason} WHERE source_id=${source.id} AND ended_at IS NULL`,
  );
  await db.execute(
    sql`UPDATE streaming_ingest_credential SET revoked_at=now() WHERE id IN(SELECT credential_id FROM restream_session WHERE source_id=${source.id}) AND revoked_at IS NULL`,
  );
  // Stop only canonical publishers owned by this registry session, preserving unrelated push sessions.
  await db.execute(
    sql`UPDATE streaming_session SET desired_state='stopped',state='stopping',updated_at=now() WHERE ingress_credential_id IN(SELECT credential_id FROM restream_session WHERE source_id=${source.id}) AND state NOT IN('ended','failed')`,
  );
}
export function registerRestreamMaintenance(app: FastifyInstance, database: RelayKitDatabase) {
  let running: Promise<void> | undefined,
    closed = false;
  const tick = async () => {
    const candidates = await database
      .select()
      .from(schema.restreamSession)
      .where(sql`ended_at IS NULL`)
      .limit(100);
    for (const candidate of candidates)
      await database.transaction(async (db) => {
        // Keep the same owners -> stream -> source -> job lock order as management and gateway admission.
        await db.execute(
          sql`SELECT t.id FROM streaming_stream t JOIN environment e ON e.id=t.environment_id JOIN project p ON p.id=t.project_id JOIN organization o ON o.id=t.organization_id WHERE t.id=${candidate.streamId} FOR SHARE OF e,p,o`,
        );
        const stream = await getStream(db, candidate.streamId, true);
        const [source] = await db
          .select()
          .from(schema.restreamSource)
          .where(eq(schema.restreamSource.id, candidate.sourceId))
          .for("update");
        const [job] = await db
          .select()
          .from(schema.restreamSession)
          .where(eq(schema.restreamSession.id, candidate.id))
          .for("update");
        if (!source || !job || job.endedAt) return;
        const now = Date.now(),
          expired = !!job.leasedUntil && job.leasedUntil.getTime() <= now;
        const terminal =
          job.desiredState === "stopped" ||
          !!source.deletedAt ||
          stream.status !== "active" ||
          job.deadline.getTime() <= now ||
          job.fetchedBytes >= source.maxBytes;
        if (terminal) {
          const reason =
            job.kind === "probe" && job.deadline.getTime() <= now
              ? "SOURCE_PROBE_TIMEOUT"
              : job.lastError;
          await stopSourceSession(db, source, reason);
          if (!job.leasedUntil || expired || job.kind === "push") {
            const failed =
              reason === "SOURCE_RETRY_EXHAUSTED" ||
              reason === "SOURCE_CONNECTION_TIMEOUT" ||
              reason === "SOURCE_PROBE_TIMEOUT" ||
              job.fetchedBytes >= source.maxBytes;
            await db.execute(
              sql`UPDATE restream_session SET state=${failed ? "failed" : "stopped"},ended_at=now(),lease_token=NULL,leased_until=NULL WHERE id=${job.id}`,
            );
            if (!source.deletedAt)
              await sourceTransition(
                db,
                source,
                failed ? "failed" : "stopped",
                job.id,
                failed ? (reason ?? "SOURCE_BYTE_LIMIT") : job.lastError,
              );
          }
          return;
        }
        if (expired) {
          await stopSourceSession(db, source);
          const retry = job.attempts <= source.reconnectBudget;
          await db.execute(
            sql`UPDATE restream_session SET desired_state=${retry ? "running" : "stopped"},state=${retry ? "recovering" : "failed"},last_error=${retry ? "SOURCE_WORKER_LOST" : "SOURCE_RETRY_EXHAUSTED"},lease_token=NULL,leased_until=NULL,available_at=now()+interval '5 seconds' WHERE id=${job.id}`,
          );
          await sourceTransition(
            db,
            source,
            retry ? "recovering" : "failed",
            job.id,
            retry ? "SOURCE_WORKER_LOST" : "SOURCE_RETRY_EXHAUSTED",
          );
          return;
        }
        if (job.kind === "push") {
          const [publisher] = await db.execute(
            sql`SELECT id,ingress_credential_id FROM streaming_session WHERE stream_id=${source.streamId} AND state='live' AND desired_state='running'`,
          );
          const state = publisher ? "live" : job.state === "live" ? "recovering" : "connecting";
          if (!publisher && job.state === "live" && job.attempts >= source.reconnectBudget + 1) {
            await stopSourceSession(db, source, "SOURCE_RETRY_EXHAUSTED");
            await sourceTransition(db, source, "failed", job.id, "SOURCE_RETRY_EXHAUSTED");
            return;
          }
          if (!publisher && job.state === "recovering" && job.availableAt.getTime() < now) {
            await stopSourceSession(db, source, "SOURCE_CONNECTION_TIMEOUT");
            return;
          }
          if (!publisher && job.state === "connecting" && job.createdAt.getTime() + 60000 < now) {
            await stopSourceSession(db, source, "SOURCE_CONNECTION_TIMEOUT");
            return;
          }
          await db.execute(
            sql`UPDATE restream_session SET state=${state},available_at=CASE WHEN state='live' AND ${state}='recovering' THEN now()+interval '60 seconds' ELSE available_at END,credential_id=coalesce(${publisher ? String(publisher.ingress_credential_id) : null},credential_id),attempts=${publisher && job.attempts === 0 ? 1 : !publisher && job.state === "live" ? job.attempts + 1 : job.attempts} WHERE id=${job.id}`,
          );
          await sourceTransition(db, source, state, job.id);
        }
      });
  };
  const timer = setInterval(() => {
    if (!closed && !running)
      running = tick()
        .catch(() => {
          app.log.error("Restream reconciliation failed");
        })
        .finally(() => {
          running = undefined;
        });
  }, 1000);
  timer.unref();
  return async () => {
    closed = true;
    clearInterval(timer);
    await running;
  };
}
