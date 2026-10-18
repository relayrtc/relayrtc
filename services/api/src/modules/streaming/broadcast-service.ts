import { recordAudit, type AuditActor } from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import type {
  BroadcastResource,
  BroadcastOutput,
  BroadcastState,
  BroadcastUsage,
} from "@relayrtc/types";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getStream, id, missing, type Transaction } from "./repository.js";
import type { StreamingConfig } from "./config.js";
import { destinationEvent } from "./destinations.js";

export type RunRow = typeof schema.broadcastRun.$inferSelect;
export type JobRow = typeof schema.broadcastJob.$inferSelect;
export const terminalJobs = ["completed", "failed", "cancelled"];
const system: AuditActor = { type: "SYSTEM", name: "Broadcast runtime" };
export async function getBroadcast(db: Transaction, broadcastId: string, lock = false) {
  const query = db
    .select()
    .from(schema.broadcastRun)
    .where(eq(schema.broadcastRun.id, broadcastId));
  const [run] = await (lock ? query.for("update") : query);
  if (!run) throw missing();
  return run;
}
export function publicBroadcast(run: RunRow): BroadcastResource {
  return {
    id: run.id,
    streamId: run.streamId,
    organizationId: run.organizationId,
    projectId: run.projectId,
    environmentId: run.environmentId,
    name: run.name,
    state: run.state as BroadcastState,
    desiredState: run.desiredState as BroadcastResource["desiredState"],
    version: run.version,
    snapshot: run.snapshot as unknown as BroadcastResource["snapshot"],
    sourceSessionId: run.sourceSessionId,
    sourceGeneration: run.sourceGeneration,
    waitTimeoutSeconds: run.waitTimeoutSeconds,
    maxDurationSeconds: run.maxDurationSeconds,
    lastError: run.lastError,
    correlationId: run.correlationId,
    createdAt: run.createdAt.toISOString(),
    startRequestedAt: run.startRequestedAt?.toISOString() ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null,
  };
}
export function publicOutput(
  job: JobRow,
  destinationId: string | null = null,
  destinationName: string | null = null,
): BroadcastOutput {
  return {
    id: job.outputId,
    broadcastId: job.broadcastId,
    kind: job.kind as "hls" | "rtmp",
    destinationId,
    destinationName,
    outputSeconds: job.outputSeconds,
    bytes: job.egressBytes,
    bitrate: job.bitrate,
    droppedFrames: job.droppedFrames,
    transcodeSeconds: job.transcodeSeconds,
    state: job.state as BroadcastOutput["state"],
    attempts: job.attempts,
    fence: job.fence,
    lastError: job.lastError,
    lastHeartbeatAt: job.lastHeartbeatAt?.toISOString() ?? null,
    sourceSessionId: job.sourceSessionId,
    sourceGeneration: job.sourceGeneration,
  };
}
export async function broadcastAudit(
  db: Transaction,
  run: RunRow,
  actor: AuditActor,
  action: string,
  correlationId?: string,
) {
  await recordAudit(db, {
    actor,
    action,
    outcome: "SUCCESS",
    resourceType: "broadcast",
    resourceId: run.id,
    organizationId: run.organizationId,
    correlationId,
  });
}
export async function broadcastEvent(
  db: Transaction,
  run: RunRow,
  type: string,
  actor: AuditActor = system,
) {
  const outputs = await db.execute(
    sql`SELECT o.id,o.kind,coalesce(j.state,'queued') AS state FROM broadcast_output o LEFT JOIN broadcast_job j ON j.output_id=o.id WHERE o.broadcast_id=${run.id}`,
  );
  const eventId = id("event"),
    occurredAt = new Date().toISOString();
  const payload = {
    id: eventId,
    type,
    projectId: run.projectId,
    environmentId: run.environmentId,
    occurredAt,
    data: {
      broadcastId: run.id,
      streamId: run.streamId,
      sourceSessionId: run.sourceSessionId,
      generation: run.sourceGeneration,
      state: run.state,
      version: run.version,
      correlationId: run.correlationId,
      actor: { type: actor.type, id: "id" in actor ? actor.id : null, name: actor.name },
      outputs,
    },
  };
  const body = JSON.stringify(payload);
  await db.execute(sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body)
    VALUES(${eventId},${eventId},${run.projectId},${run.environmentId},${type},${occurredAt},${body}::jsonb,${body})`);
}
export async function changeBroadcast(
  db: Transaction,
  run: RunRow,
  state: BroadcastState,
  reason: string | null = null,
) {
  if (run.state === state) return run;
  const [updated] = await db
    .update(schema.broadcastRun)
    .set({
      state,
      version: run.version + 1,
      lastError: reason,
      ...(state === "live" && !run.startedAt ? { startedAt: new Date() } : {}),
      ...(state === "stopped" || state === "failed"
        ? { desiredState: "stopped", endedAt: new Date() }
        : {}),
    })
    .where(eq(schema.broadcastRun.id, run.id))
    .returning();
  if (!updated) throw missing();
  const eventType = state === "degraded" ? "broadcast.output_degraded" : `broadcast.${state}`;
  if (["starting", "live", "reconnecting", "degraded", "stopped", "failed"].includes(state)) {
    await broadcastEvent(db, updated, eventType);
    await broadcastAudit(db, updated, system, eventType, updated.correlationId ?? undefined);
  }
  return updated;
}
export async function requestBroadcastStop(
  db: Transaction,
  run: RunRow,
  reason: string | null = null,
  failed = false,
) {
  if (["stopped", "failed"].includes(run.state)) return;
  await db
    .update(schema.broadcastRun)
    .set({
      desiredState: "stopped",
      terminalState: failed || run.terminalState === "failed" ? "failed" : "stopped",
      lastError: run.terminalState === "failed" ? run.lastError : reason,
    })
    .where(eq(schema.broadcastRun.id, run.id));
  await changeBroadcast(db, run, "stopping", reason);
  await db.execute(
    sql`UPDATE broadcast_job SET desired_state='cancelled',state='stopping' WHERE broadcast_id=${run.id} AND state NOT IN ('completed','failed','cancelled')`,
  );
  await db.execute(
    sql`UPDATE streaming_operation SET status='failed',error_code=${reason ?? "BROADCAST_STOPPED"},completed_at=now() WHERE broadcast_id=${run.id} AND kind='broadcast.start' AND status='pending'`,
  );
}
export async function broadcastOperation(
  db: Transaction,
  run: RunRow,
  kind: "broadcast.start" | "broadcast.stop",
) {
  const [op] = await db
    .insert(schema.streamingOperation)
    .values({
      id: id("sop"),
      streamId: run.streamId,
      broadcastId: run.id,
      kind,
      ...(kind === "broadcast.stop" && ["stopped", "failed"].includes(run.state)
        ? { status: "completed", completedAt: new Date() }
        : {}),
    })
    .returning();
  return op;
}
export async function releaseJob(db: Transaction, job: JobRow, outcome: string) {
  if (job.kind === "rtmp" && job.leasedUntil) {
    const run = await getBroadcast(db, job.broadcastId);
    const [output] = await db
      .select()
      .from(schema.broadcastOutput)
      .where(eq(schema.broadcastOutput.id, job.outputId));
    if (output?.destinationId)
      await destinationEvent(db, run, "destination.disconnected", {
        destinationId: output.destinationId,
        broadcastId: run.id,
        outputId: job.outputId,
        fence: job.fence,
        reason: outcome,
        correlationId: run.correlationId,
      });
  }
  await db.execute(
    sql`UPDATE broadcast_attempt SET ended_at=coalesce(ended_at,now()),outcome=coalesce(outcome,${outcome}) WHERE job_id=${job.id} AND fence=${job.fence}`,
  );
  await db.execute(
    sql`DELETE FROM broadcast_reservation WHERE job_id=${job.id} AND fence=${job.fence}`,
  );
  await db
    .update(schema.broadcastJob)
    .set({ leasedUntil: null, leaseToken: null, workerId: null, observedLive: 0 })
    .where(eq(schema.broadcastJob.id, job.id));
}
export async function retryJob(db: Transaction, job: JobRow, reason: string) {
  await releaseJob(db, job, reason);
  const exhausted = job.attempts >= 3;
  if (job.kind === "rtmp") {
    const run = await getBroadcast(db, job.broadcastId);
    const [output] = await db
      .select()
      .from(schema.broadcastOutput)
      .where(eq(schema.broadcastOutput.id, job.outputId));
    if (output?.destinationId)
      await destinationEvent(db, run, exhausted ? "destination.failed" : "destination.retrying", {
        destinationId: output.destinationId,
        broadcastId: run.id,
        outputId: job.outputId,
        fence: job.fence,
        reason,
        correlationId: run.correlationId,
      });
  }
  if (exhausted)
    await db.execute(
      sql`UPDATE streaming_operation SET status='failed',error_code=${reason},completed_at=now() WHERE output_id=${job.outputId} AND kind='broadcast.output.retry' AND status='pending'`,
    );
  await db
    .update(schema.broadcastJob)
    .set({
      state: exhausted ? "failed" : "retry",
      desiredState: "running",
      lastError: reason,
      fence: job.fence + 1,
      availableAt: new Date(Date.now() + Math.min(30000, 1000 * 2 ** job.attempts)),
    })
    .where(eq(schema.broadcastJob.id, job.id));
}
export async function sampleJob(
  db: Transaction,
  job: JobRow,
  run: RunRow,
  sequence: number,
  live: boolean,
  gap = false,
  bytes = job.observedBytes,
  dropped = job.observedDropped,
) {
  const elapsed = job.lastHeartbeatAt ? (Date.now() - job.lastHeartbeatAt.getTime()) / 1000 : 0;
  const observed = !gap && elapsed >= 0 && elapsed <= 10;
  const reserved =
    job.lastHeartbeatAt && job.leasedUntil
      ? Math.max(
          0,
          (Math.min(Date.now(), job.leasedUntil.getTime()) - job.lastHeartbeatAt.getTime()) / 1000,
        )
      : 0;
  const liveSeconds = observed && live && job.observedLive ? elapsed : 0;
  const deltaBytes = Math.max(0, bytes - job.observedBytes),
    deltaDropped = Math.max(0, dropped - job.observedDropped);
  const [output] = await db
    .select()
    .from(schema.broadcastOutput)
    .where(eq(schema.broadcastOutput.id, job.outputId));
  const transcodeSeconds =
    job.kind === "rtmp" && output?.configuration.profile !== "remux" ? liveSeconds : 0;
  const inserted =
    await db.execute(sql`INSERT INTO broadcast_usage_sample(job_id,fence,sequence,broadcast_id,organization_id,project_id,environment_id,output_seconds,reservation_seconds,coverage,egress_bytes,transcode_seconds)
    VALUES(${job.id},${job.fence},${sequence},${run.id},${run.organizationId},${run.projectId},${run.environmentId},${liveSeconds},${reserved},${observed ? "observed" : "partial"},${deltaBytes},${transcodeSeconds}) ON CONFLICT DO NOTHING RETURNING job_id`);
  if (inserted.length) {
    await db.execute(
      sql`UPDATE broadcast_run SET run_seconds=run_seconds+${job.kind === "hls" ? liveSeconds : 0},output_seconds=output_seconds+${liveSeconds},egress_bytes=egress_bytes+${deltaBytes},transcode_seconds=transcode_seconds+${transcodeSeconds},reservation_seconds=reservation_seconds+${reserved},usage_samples=usage_samples+1,partial_samples=partial_samples+${observed ? 0 : 1} WHERE id=${run.id}`,
    );
    await db.execute(
      sql`UPDATE broadcast_job SET egress_bytes=egress_bytes+${deltaBytes},observed_bytes=${bytes},dropped_frames=dropped_frames+${deltaDropped},observed_dropped=${dropped},output_seconds=output_seconds+${liveSeconds},transcode_seconds=transcode_seconds+${transcodeSeconds} WHERE id=${job.id}`,
    );
  }
}
export function broadcastUsage(run: RunRow): BroadcastUsage {
  return {
    runSeconds: run.runSeconds,
    bytes: run.egressBytes,
    transcodeSeconds: run.transcodeSeconds,
    outputSeconds: run.outputSeconds,
    reservationSeconds: run.reservationSeconds,
    samples: run.usageSamples,
    coverage: run.usageSamples > 0 && run.partialSamples === 0 ? "observed" : "partial",
  };
}
export async function reconcileBroadcast(db: Transaction, run: RunRow, config: StreamingConfig) {
  if (["stopped", "failed"].includes(run.state)) return;
  const stream = await getStream(db, run.streamId);
  if ((!config.broadcastsEnabled || stream.status !== "active") && run.desiredState !== "stopped") {
    await requestBroadcastStop(
      db,
      run,
      config.broadcastsEnabled ? "SOURCE_RETIRED" : "BROADCASTS_DISABLED",
    );
    run = await getBroadcast(db, run.id);
  }
  let jobs = await db
    .select()
    .from(schema.broadcastJob)
    .where(eq(schema.broadcastJob.broadcastId, run.id))
    .for("update");
  for (const job of jobs) {
    if (job.leasedUntil && job.leasedUntil.getTime() <= Date.now()) {
      await sampleJob(db, job, run, job.sampleSequence + 1, false, true);
      if (run.desiredState === "stopped" || job.desiredState === "cancelled") {
        await releaseJob(db, job, "CANCELLED");
        await db
          .update(schema.broadcastJob)
          .set({
            state: job.lastError === "EGRESS_BYTE_LIMIT" ? "failed" : "cancelled",
            fence: job.fence + 1,
          })
          .where(eq(schema.broadcastJob.id, job.id));
      } else await retryJob(db, job, "WORKER_LEASE_EXPIRED");
    } else if (
      !job.leasedUntil &&
      (run.desiredState === "stopped" || job.desiredState === "cancelled") &&
      !terminalJobs.includes(job.state)
    ) {
      await releaseJob(db, job, "CANCELLED");
      await db
        .update(schema.broadcastJob)
        .set({
          state: job.lastError === "EGRESS_BYTE_LIMIT" ? "failed" : "cancelled",
          fence: job.fence + 1,
        })
        .where(eq(schema.broadcastJob.id, job.id));
    }
  }
  jobs = await db
    .select()
    .from(schema.broadcastJob)
    .where(eq(schema.broadcastJob.broadcastId, run.id));
  if (run.desiredState === "stopped") {
    if (run.state !== "stopping") run = await changeBroadcast(db, run, "stopping", run.lastError);
    if (jobs.every((job) => terminalJobs.includes(job.state))) {
      run = await changeBroadcast(
        db,
        run,
        run.terminalState === "failed" ? "failed" : "stopped",
        run.lastError,
      );
      await db.execute(
        sql`UPDATE streaming_operation SET status='completed',completed_at=now() WHERE broadcast_id=${run.id} AND kind='broadcast.stop' AND status='pending'`,
      );
      await db.execute(
        sql`UPDATE streaming_operation SET status='failed',error_code='BROADCAST_STOPPED',completed_at=now() WHERE broadcast_id=${run.id} AND kind='broadcast.output.retry' AND status='pending'`,
      );
    }
    return;
  }
  if (run.desiredState === "idle") return;
  if (
    JSON.stringify(stream.source) !== JSON.stringify(run.snapshot.source) ||
    JSON.stringify(stream.profile) !== JSON.stringify(run.snapshot.profile)
  ) {
    await requestBroadcastStop(db, run, "SOURCE_CONFIGURATION_CHANGED", true);
    return;
  }
  if (
    run.startRequestedAt &&
    Date.now() - run.startRequestedAt.getTime() > run.maxDurationSeconds * 1000
  ) {
    await requestBroadcastStop(db, run, "BROADCAST_DURATION_LIMIT");
    return;
  }
  const [session] = await db
    .select()
    .from(schema.streamingSession)
    .where(
      sql`stream_id=${run.streamId} AND desired_state='running' AND state NOT IN ('ended','failed')`,
    )
    .orderBy(sql`created_at DESC`)
    .limit(1);
  if (
    session?.state !== "live" ||
    !session.leasedUntil ||
    session.leasedUntil.getTime() <= Date.now()
  ) {
    const lostAt = run.sourceLostAt ?? new Date();
    await db
      .update(schema.broadcastRun)
      .set({ sourceLostAt: lostAt })
      .where(eq(schema.broadcastRun.id, run.id));
    for (const job of jobs)
      if (job.observedLive)
        await db
          .update(schema.broadcastJob)
          .set({ observedLive: 0 })
          .where(eq(schema.broadcastJob.id, job.id));
    if (run.sourceSessionId) {
      const [old] = await db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, run.sourceSessionId));
      if (old?.desiredState === "stopped") {
        await requestBroadcastStop(db, run, "SOURCE_ENDED");
        return;
      }
      if (!["reconnecting", "waiting_for_source"].includes(run.state))
        await changeBroadcast(db, run, "reconnecting", "SOURCE_UNAVAILABLE");
    }
    if (Date.now() - lostAt.getTime() > run.waitTimeoutSeconds * 1000)
      await requestBroadcastStop(db, run, "SOURCE_WAIT_TIMEOUT", true);
    return;
  }
  const changed = run.sourceSessionId !== session.id || run.sourceGeneration !== session.generation;
  if (changed) {
    await db
      .update(schema.broadcastRun)
      .set({
        sourceSessionId: session.id,
        sourceGeneration: session.generation,
        sourceLostAt: null,
      })
      .where(eq(schema.broadcastRun.id, run.id));
    for (const job of jobs)
      if (job.leasedUntil) {
        // Retain the slot until the old attempt acknowledges teardown or expires.
        await db
          .update(schema.broadcastJob)
          .set({
            state: "stopping",
            desiredState: "restart",
            observedLive: 0,
            lastError: "SOURCE_GENERATION_CHANGED",
          })
          .where(eq(schema.broadcastJob.id, job.id));
      }
    run = await getBroadcast(db, run.id);
  } else if (run.sourceLostAt)
    await db
      .update(schema.broadcastRun)
      .set({ sourceLostAt: null })
      .where(eq(schema.broadcastRun.id, run.id));
  jobs = await db
    .select()
    .from(schema.broadcastJob)
    .where(eq(schema.broadcastJob.broadcastId, run.id));
  if (jobs.every((job) => job.state === "failed")) {
    await changeBroadcast(db, run, "degraded", "OUTPUT_RETRY_EXHAUSTED");
    await requestBroadcastStop(db, await getBroadcast(db, run.id), "OUTPUT_RETRY_EXHAUSTED", true);
    return;
  }
  const live = jobs.filter(
    (job) =>
      job.state === "running" &&
      job.observedLive &&
      job.leasedUntil &&
      job.leasedUntil.getTime() > Date.now(),
  );
  const next =
    live.length === jobs.length
      ? "live"
      : jobs.some(
            (job) => job.state === "failed" || job.state === "retry" || job.state === "cancelled",
          )
        ? "degraded"
        : "starting";
  run = await changeBroadcast(db, run, next);
  if (live.length > 0)
    await db.execute(
      sql`UPDATE streaming_operation SET status='completed',completed_at=now() WHERE broadcast_id=${run.id} AND kind='broadcast.start' AND status='pending'`,
    );
  for (const job of live)
    await db.execute(
      sql`UPDATE streaming_operation SET status='completed',completed_at=now() WHERE output_id=${job.outputId} AND kind='broadcast.output.retry' AND status='pending'`,
    );
}
export function registerBroadcastMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  let closing = false,
    pending: Promise<void> | undefined;
  const tick = async () => {
    const candidates = await database
      .select({ id: schema.broadcastRun.id })
      .from(schema.broadcastRun)
      .where(
        sql`state NOT IN ('stopped','failed') AND (desired_state<>'idle' OR ${!config.broadcastsEnabled})`,
      )
      .limit(config.maxBroadcasts + 200);
    for (const candidate of candidates) {
      if (closing) break;
      await database.transaction(async (db) => {
        const [run] = await db
          .select()
          .from(schema.broadcastRun)
          .where(eq(schema.broadcastRun.id, candidate.id))
          .for("update", { skipLocked: true });
        if (run) await reconcileBroadcast(db, run, config);
      });
    }
  };
  const timer = setInterval(() => {
    if (closing || pending) return;
    pending = tick()
      .catch(() => {
        app.log.warn("Broadcast maintenance will retry");
      })
      .finally(() => {
        pending = undefined;
      });
  }, 2000);
  timer.unref();
  return async () => {
    closing = true;
    clearInterval(timer);
    await pending;
  };
}
