import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { StreamingConfig } from "./config.js";
import { StreamingGateway, ingestPath, programPath } from "./gateway.js";
import { StreamingStore } from "./store.js";
import {
  audit,
  conflict,
  event,
  getStream,
  id,
  type Transaction,
  type StreamRow,
  type SessionRow,
} from "./repository.js";

export async function startSession(
  db: Transaction,
  stream: StreamRow,
  config: StreamingConfig,
  ingress?: { id: string; type: string; credentialId: string },
) {
  if (stream.status !== "active") throw conflict("STREAM_RETIRED", "This stream is being removed");
  await db.execute(sql`SELECT pg_advisory_xact_lock(810032)`);
  const [active] = await db
    .select()
    .from(schema.streamingSession)
    .where(sql`stream_id=${stream.id} AND state NOT IN ('ended','failed')`)
    .for("update");
  if (active) {
    if (active.ingressId === ingress?.id && active.desiredState === "running") return active;
    if (
      ingress &&
      active.state === "reconnecting" &&
      active.desiredState === "running" &&
      active.ingressId === null &&
      active.ingressCredentialId === ingress.credentialId
    ) {
      const [updated] = await db
        .update(schema.streamingSession)
        .set({ ingressId: ingress.id, ingressType: ingress.type, updatedAt: new Date() })
        .where(eq(schema.streamingSession.id, active.id))
        .returning();
      return required(updated);
    }
    throw conflict("PUBLISHER_CONFLICT", "A source session already owns this stream");
  }
  const [count] = await db.execute(
    sql`SELECT count(*)::int AS n FROM streaming_session WHERE state NOT IN ('ended','failed')`,
  );
  if (Number(count?.n) >= config.maxSessions)
    throw conflict("STREAM_CAPACITY", "Streaming source capacity is full");
  const [session] = await db
    .insert(schema.streamingSession)
    .values({
      id: id("source"),
      streamId: stream.id,
      ...(ingress
        ? {
            ingressId: ingress.id,
            ingressType: ingress.type,
            ingressCredentialId: ingress.credentialId,
          }
        : {}),
    })
    .returning();
  await event(db, stream, "stream.starting", required(session).id);
  return required(session);
}
export async function stopSessions(db: Transaction, streamId: string) {
  const rows = await db.execute<{ id: string }>(
    sql`UPDATE streaming_session SET desired_state='stopped',state='stopping',updated_at=now() WHERE stream_id=${streamId} AND state NOT IN ('ended','failed') RETURNING id`,
  );
  return rows[0]?.id ?? null;
}
// Close an abandoned observation window without inventing duration or byte totals.
export async function recordObservationGap(
  db: Transaction,
  session: SessionRow,
  stream: StreamRow,
) {
  const start = session.lastHeartbeatAt ?? session.createdAt;
  await db.execute(sql`INSERT INTO streaming_usage_sample(session_id,generation,sequence,stream_id,organization_id,project_id,environment_id,start_at,end_at,source_seconds,ingress_bytes,program_bytes,coverage)
    VALUES(${session.id},${session.generation},${session.sampleSequence + 1},${stream.id},${stream.organizationId},${stream.projectId},${stream.environmentId},${start.toISOString()},greatest(now(),${start.toISOString()}::timestamptz),0,0,0,'partial') ON CONFLICT DO NOTHING`);
}
export async function transition(
  db: Transaction,
  session: SessionRow,
  state: "live" | "reconnecting" | "ended" | "failed",
  reason: string | null = null,
) {
  if (session.state === state) return;
  const terminal = state === "ended" || state === "failed";
  await db
    .update(schema.streamingSession)
    .set({
      state,
      lastError: reason,
      updatedAt: new Date(),
      ...(terminal
        ? { endedAt: new Date(), desiredState: "stopped", leasedUntil: null, leaseToken: null }
        : {}),
    })
    .where(eq(schema.streamingSession.id, session.id));
  const stream = await getStream(db, session.streamId);
  if (terminal) await recordObservationGap(db, session, stream);
  await event(db, stream, `stream.${state}`, session.id);
  await audit(db, stream, { type: "SYSTEM", name: "Streaming runtime" }, `stream.${state}`);
  if (state === "live")
    await db.execute(
      sql`UPDATE streaming_operation SET status='completed',completed_at=now() WHERE session_id=${session.id} AND kind='start' AND status='pending'`,
    );
  if (terminal)
    await db.execute(
      sql`UPDATE streaming_operation SET status='failed',error_code=${reason ?? "SOURCE_STOPPED"},completed_at=now() WHERE session_id=${session.id} AND kind='start' AND status='pending'`,
    );
}

// Runs without a queue dependency. Gateway teardown must succeed before terminal status.
export function registerStreamingMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  const gateway = new StreamingGateway(config),
    store = new StreamingStore(config);
  let closing = false,
    pending: Promise<void> | undefined;
  const tick = async () => {
    await database.transaction(async (leaderTransaction) => {
      const [leader] = await leaderTransaction.execute(
        sql`SELECT pg_try_advisory_xact_lock(810033) AS acquired`,
      );
      if (!leader?.acquired) return;
      const db = database;
      await db.execute(sql`DELETE FROM streaming_idempotency WHERE expires_at<=now()`);
      const rows = await db
        .select()
        .from(schema.streamingSession)
        .where(sql`state NOT IN ('ended','failed')`)
        .limit(config.maxSessions);
      for (const candidate of rows)
        await database.transaction(async (db) => {
          const [session] = await db
            .select()
            .from(schema.streamingSession)
            .where(sql`id=${candidate.id} AND state NOT IN ('ended','failed')`)
            .for("update", { skipLocked: true });
          if (!session) return;
          const stream = await getStream(db, session.streamId);
          const expiredLease =
            session.leasedUntil !== null && session.leasedUntil.getTime() < Date.now();
          let reason: string | null = null;
          if (Date.now() - session.createdAt.getTime() > stream.maxDurationSeconds * 1000)
            reason = "SOURCE_DURATION_LIMIT";
          if (session.ingressCredentialId) {
            const [credential] = await db.execute(
              sql`SELECT id FROM streaming_ingest_credential WHERE id=${session.ingressCredentialId} AND revoked_at IS NULL AND expires_at>now()`,
            );
            if (!credential) reason = "INGEST_CREDENTIAL_EXPIRED";
          }
          if (session.state === "reconnecting" && Date.now() - session.updatedAt.getTime() > 30000)
            reason = "SOURCE_RECONNECT_TIMEOUT";
          if (session.state === "starting" && Date.now() - session.createdAt.getTime() > 60000)
            reason = "SOURCE_START_TIMEOUT";
          if (expiredLease && session.attempts >= 3) reason = "WORKER_RETRY_EXHAUSTED";
          if (session.desiredState === "stopped" && session.lastError === "INGRESS_BITRATE_LIMIT")
            reason = session.lastError;
          if (session.desiredState === "stopped" || stream.status !== "active" || reason) {
            // Desired state fences admission immediately, even when gateway cleanup needs retry.
            await db.execute(
              sql`UPDATE streaming_session SET desired_state='stopped' WHERE id=${session.id}`,
            );
            await gateway.removePath(programPath(session.id, session.generation));
            if (session.ingressId && session.ingressType)
              await gateway.kick(session.ingressType, session.ingressId);
            // Keep reusable ingest configuration after a stop; the retired stream's credentials
            // are denied by admission, and its path can be removed permanently.
            if (stream.status !== "active") await gateway.removePath(ingestPath(stream.id));
            await transition(db, session, reason ? "failed" : "ended", reason);
          } else if (expiredLease) {
            await gateway.removePath(programPath(session.id, session.generation));
            await transition(db, session, "reconnecting", "WORKER_LEASE_EXPIRED");
          } else if (stream.source.kind !== "room" && session.ingressId) {
            const current = await gateway.path(ingestPath(stream.id));
            if (!current?.ready && Date.now() - session.createdAt.getTime() > 10000) {
              await db.execute(
                sql`UPDATE streaming_session SET ingress_id=NULL WHERE id=${session.id}`,
              );
              await transition(db, session, "reconnecting", "INGEST_DISCONNECTED");
            }
          }
        });
      // Parent deletion preserves historical stream and usage rows, but never its media objects.
      const objects =
        await db.execute(sql`SELECT o.session_id,o.name,o.object_key FROM streaming_object o JOIN streaming_session s ON s.id=o.session_id JOIN streaming_stream t ON t.id=s.stream_id
        WHERE (o.expires_at<now() AND NOT EXISTS(SELECT 1 FROM streaming_object m WHERE m.session_id=o.session_id AND o.name=ANY(m.referenced_names) AND m.expires_at>now())) OR (t.status<>'active' AND (o.committed_at IS NOT NULL OR o.expires_at<now())) ORDER BY o.expires_at LIMIT 512`);
      // Object I/O must never hold source-session locks or stall healthy heartbeats.
      for (let index = 0; index < objects.length; index += 4) {
        const removals = await Promise.allSettled(
          objects.slice(index, index + 4).map((object) =>
            database.transaction(async (db) => {
              const [current] =
                await db.execute(sql`SELECT o.object_key FROM streaming_object o JOIN streaming_session s ON s.id=o.session_id JOIN streaming_stream t ON t.id=s.stream_id
            WHERE o.session_id=${String(object.session_id)} AND o.name=${String(object.name)} AND ((o.expires_at<now() AND NOT EXISTS(SELECT 1 FROM streaming_object m WHERE m.session_id=o.session_id AND o.name=ANY(m.referenced_names) AND m.expires_at>now())) OR (t.status<>'active' AND (o.committed_at IS NOT NULL OR o.expires_at<now()))) FOR UPDATE OF o SKIP LOCKED`);
              if (!current) return;
              await store.remove(String(current.object_key));
              await db.execute(
                sql`DELETE FROM streaming_object WHERE session_id=${String(object.session_id)} AND name=${String(object.name)}`,
              );
            }),
          ),
        );
        if (removals.some((result) => result.status === "rejected"))
          throw new Error("STREAMING_OBJECT_CLEANUP_RETRY");
      }
      const retiring = await db.execute<{ id: string }>(
        sql`SELECT id FROM streaming_stream WHERE status='deleting' LIMIT 50`,
      );
      for (const stream of retiring) {
        await gateway.removePath(ingestPath(stream.id));
        await db.execute(
          sql`UPDATE streaming_ingest_credential SET revoked_at=now() WHERE stream_id=${stream.id} AND revoked_at IS NULL`,
        );
      }
      await db.execute(sql`UPDATE streaming_stream t SET status='deleted',updated_at=now() WHERE status='deleting'
        AND id=ANY(${retiring.map((row) => row.id)}::text[])
        AND NOT EXISTS(SELECT 1 FROM streaming_session s WHERE s.stream_id=t.id AND s.state NOT IN ('ended','failed'))
        AND NOT EXISTS(SELECT 1 FROM streaming_object o JOIN streaming_session s ON s.id=o.session_id WHERE s.stream_id=t.id)`);
      await db.execute(sql`UPDATE streaming_operation o SET status='completed',completed_at=now() FROM streaming_stream t WHERE o.stream_id=t.id AND o.status='pending'
        AND ((o.kind='delete' AND t.status='deleted') OR (o.kind='stop' AND (o.session_id IS NULL OR EXISTS(SELECT 1 FROM streaming_session s WHERE s.id=o.session_id AND s.state IN ('ended','failed')))))`);
    });
  };
  const timer = setInterval(() => {
    if (closing || pending) return;
    pending = tick()
      .catch(() => {
        app.log.warn("Streaming maintenance will retry");
      })
      .finally(() => {
        pending = undefined;
      });
  }, 5000);
  timer.unref();
  return async () => {
    closing = true;
    clearInterval(timer);
    await pending;
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
