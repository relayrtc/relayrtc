import { recordAudit, type AuditActor } from "@relayrtc/auth/server";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { ScheduledBroadcast, ScheduleTiming } from "@relayrtc/types";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import {
  authorize,
  getStream,
  id,
  secret,
  missing,
  conflict,
  type Transaction,
} from "./repository.js";
import type { StreamingConfig } from "./config.js";
import { getBroadcast, requestBroadcastStop } from "./broadcast-service.js";
import { startBroadcastRun } from "./broadcast-commands.js";

const date = z.coerce.date();
export const scheduleRowSchema = z.object({
  id: z.string(),
  stream_id: z.string(),
  broadcast_id: z.string(),
  operation_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  name: z.string(),
  creator_type: z.enum(["key", "user"]),
  creator_id: z.string(),
  state: z.enum([
    "scheduled",
    "starting",
    "running",
    "ending",
    "completed",
    "missed",
    "failed",
    "cancelled",
  ]),
  version: z.number(),
  grant_epoch: z.number(),
  source_deadline: date.nullable(),
  starts_at: date,
  ends_at: date,
  time_zone: z.string(),
  source_wait_seconds: z.number(),
  catch_up_seconds: z.number(),
  publisher_early_seconds: z.number(),
  viewer_early_seconds: z.number(),
  viewer_after_seconds: z.number(),
  notify_before_seconds: z.number().nullable(),
  fence: z.number(),
  attempts: z.number(),
  lease_token: z.string().nullable(),
  leased_until: date.nullable(),
  last_error: z.string().nullable(),
  created_at: date,
  updated_at: date,
  started_at: date.nullable(),
  ended_at: date.nullable(),
});
export type ScheduleRow = z.infer<typeof scheduleRowSchema>;
export const schedulerActor: AuditActor = { type: "SYSTEM", name: "Broadcast scheduler" };
export const publisherOpens = (s: ScheduleRow) =>
  new Date(s.starts_at.getTime() - s.publisher_early_seconds * 1000);
export const viewerOpens = (s: ScheduleRow) =>
  new Date(s.starts_at.getTime() - s.viewer_early_seconds * 1000);
export const viewerCloses = (s: ScheduleRow) =>
  new Date(s.ends_at.getTime() + s.viewer_after_seconds * 1000);
export const readinessDeadline = (s: ScheduleRow) =>
  s.source_deadline ??
  new Date(Math.min(s.ends_at.getTime(), s.starts_at.getTime() + s.source_wait_seconds * 1000));
export function publicSchedule(s: ScheduleRow): ScheduledBroadcast {
  return {
    id: s.id,
    streamId: s.stream_id,
    broadcastId: s.broadcast_id,
    operationId: s.operation_id,
    organizationId: s.organization_id,
    projectId: s.project_id,
    environmentId: s.environment_id,
    name: s.name,
    state: s.state,
    version: s.version,
    lastError: s.last_error,
    startsAt: s.starts_at.toISOString(),
    endsAt: s.ends_at.toISOString(),
    timeZone: s.time_zone,
    sourceWaitSeconds: s.source_wait_seconds,
    catchUpSeconds: s.catch_up_seconds,
    publisherEarlySeconds: s.publisher_early_seconds,
    viewerEarlySeconds: s.viewer_early_seconds,
    viewerAfterSeconds: s.viewer_after_seconds,
    notifyBeforeSeconds: s.notify_before_seconds,
    publisherOpensAt: publisherOpens(s).toISOString(),
    viewerOpensAt: viewerOpens(s).toISOString(),
    viewerClosesAt: viewerCloses(s).toISOString(),
    readinessDeadline: readinessDeadline(s).toISOString(),
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
    startedAt: s.started_at?.toISOString() ?? null,
    endedAt: s.ended_at?.toISOString() ?? null,
  };
}
export async function getSchedule(db: Transaction, scheduleId: string, lock = false) {
  const [row] = await db.execute(
    sql`SELECT * FROM broadcast_schedule WHERE id=${scheduleId} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  if (!row) throw missing();
  return scheduleRowSchema.parse(row);
}
export async function scheduleEvent(
  db: Transaction,
  s: ScheduleRow,
  type: string,
  actor: AuditActor = schedulerActor,
) {
  const [sequence] = await db.execute(
    sql`UPDATE broadcast_schedule SET event_sequence=event_sequence+1 WHERE id=${s.id} RETURNING event_sequence`,
  );
  const eventId = id("event"),
    occurredAt = new Date().toISOString(),
    body = JSON.stringify({
      id: eventId,
      type,
      projectId: s.project_id,
      environmentId: s.environment_id,
      occurredAt,
      data: {
        scheduleId: s.id,
        streamId: s.stream_id,
        broadcastId: s.broadcast_id,
        operationId: s.operation_id,
        state: s.state,
        version: s.version,
        startsAt: s.starts_at.toISOString(),
        endsAt: s.ends_at.toISOString(),
        sequence: Number(sequence?.event_sequence),
        actor,
      },
    });
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${s.project_id},${s.environment_id},${type},${occurredAt},${body}::jsonb,${body})`,
  );
  await recordAudit(db, {
    actor,
    action: type,
    outcome: "SUCCESS",
    organizationId: s.organization_id,
    resourceType: "schedule",
    resourceId: s.id,
    correlationId: s.operation_id,
  });
}
export async function revokeScheduleAccess(db: Transaction, s: ScheduleRow) {
  await db.execute(
    sql`UPDATE schedule_viewer_grant SET revoked_at=now() WHERE schedule_id=${s.id} AND revoked_at IS NULL`,
  );
  await db.execute(
    sql`UPDATE streaming_ingest_credential SET revoked_at=now() WHERE schedule_id=${s.id} AND revoked_at IS NULL`,
  );
  await db.execute(
    sql`UPDATE streaming_session SET desired_state='stopped',state='stopping',updated_at=now() WHERE ingress_credential_id IN (SELECT id FROM streaming_ingest_credential WHERE schedule_id=${s.id}) AND state NOT IN ('ended','failed')`,
  );
  await db.execute(
    sql`UPDATE schedule_notification SET state='cancelled' WHERE schedule_id=${s.id} AND state='pending'`,
  );
}
export async function transitionSchedule(
  db: Transaction,
  s: ScheduleRow,
  state: ScheduleRow["state"],
  reason: string | null = null,
  actor: AuditActor = schedulerActor,
) {
  if (s.state === state) return s;
  const terminal = ["completed", "missed", "failed", "cancelled"].includes(state);
  const [row] = await db.execute(
    sql`UPDATE broadcast_schedule SET state=${state},version=version+1,last_error=${reason},updated_at=now(),started_at=CASE WHEN ${state}='running' THEN coalesce(started_at,now()) ELSE started_at END,ended_at=CASE WHEN ${terminal} THEN now() ELSE ended_at END,lease_token=NULL,leased_until=NULL WHERE id=${s.id} RETURNING *`,
  );
  const updated = scheduleRowSchema.parse(row);
  if (state === "starting")
    await db.execute(
      sql`UPDATE schedule_notification SET state='cancelled' WHERE schedule_id=${s.id} AND state='pending'`,
    );
  if (terminal) {
    await revokeScheduleAccess(db, updated);
    await db.execute(
      sql`UPDATE schedule_operation SET status=${state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed"},error_code=${reason},completed_at=coalesce(completed_at,now()) WHERE id=${s.operation_id} AND status='pending'`,
    );
  } else if (state === "running")
    await db.execute(
      sql`UPDATE schedule_operation SET status='completed',completed_at=now() WHERE id=${s.operation_id} AND status='pending'`,
    );
  const event = state === "running" ? "started" : state;
  if (event !== "ending") await scheduleEvent(db, updated, `schedule.${event}`, actor);
  return updated;
}
export async function ensureScheduleWindow(
  db: Transaction,
  streamId: string,
  timing: ScheduleTiming,
  exclude?: string,
) {
  const begins = new Date(
    Date.parse(timing.startsAt) - timing.publisherEarlySeconds * 1000,
  ).toISOString();
  const [overlap] = await db.execute(
    sql`SELECT id FROM broadcast_schedule WHERE stream_id=${streamId} AND state IN ('scheduled','starting','running','ending') ${exclude ? sql`AND id<>${exclude}` : sql``} AND starts_at-make_interval(secs=>publisher_early_seconds)<${timing.endsAt}::timestamptz AND ends_at>${begins}::timestamptz`,
  );
  if (overlap)
    throw conflict(
      "SCHEDULE_WINDOW_OVERLAP",
      "Publisher windows for this stream must not overlap.",
    );
}
export async function configureNotification(
  db: Transaction,
  s: ScheduleRow,
  config: StreamingConfig,
) {
  if (s.notify_before_seconds === null) return;
  if (!config.scheduleNotificationsEnabled)
    throw new ApiError(
      503,
      "SCHEDULE_NOTIFICATIONS_DISABLED",
      "Enable the signed webhook notification provider before scheduling a reminder.",
    );
  const [endpoint] = await db.execute(
    sql`SELECT id FROM webhook_endpoint WHERE project_id=${s.project_id} AND environment_id=${s.environment_id} AND status='enabled' AND 'schedule.reminder'=ANY(event_types) LIMIT 1`,
  );
  if (!endpoint)
    throw conflict(
      "SCHEDULE_NOTIFICATION_PROVIDER_REQUIRED",
      "Configure an enabled webhook subscription for schedule.reminder.",
    );
  await db.execute(
    sql`INSERT INTO schedule_notification(id,schedule_id,version,due_at) VALUES(${id("notification")},${s.id},${s.version},${new Date(s.starts_at.getTime() - s.notify_before_seconds * 1000).toISOString()})`,
  );
}
async function executionAuthority(db: Transaction, s: ScheduleRow) {
  const stream = await getStream(db, s.stream_id);
  if (s.creator_type === "user")
    await authorize(db, { type: "user", userId: s.creator_id }, stream, "streams:write");
  else {
    const [key] = await db.execute(
      sql`SELECT id,type,project_id,environment_id,scopes FROM api_key WHERE id=${s.creator_id} AND type='secret' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) FOR SHARE`,
    );
    if (!key)
      throw new ApiError(
        403,
        "SCHEDULE_AUTHORITY_REVOKED",
        "The schedule creator no longer has permission.",
      );
    await authorize(
      db,
      {
        type: "key",
        key: {
          keyId: s.creator_id,
          keyType: "secret",
          projectId: z.string().parse(key.project_id),
          environmentId: z.string().parse(key.environment_id),
          scopes: z.array(z.string()).parse(key.scopes),
        },
      },
      stream,
      "streams:write",
    );
    const run = await getBroadcast(db, s.broadcast_id);
    if (
      run.snapshot.recording &&
      !z.array(z.string()).parse(key.scopes).includes("recordings:create")
    )
      throw new ApiError(
        403,
        "SCHEDULE_RECORDING_SCOPE_REQUIRED",
        "Recording permission is required.",
      );
  }
  return stream;
}
export function registerScheduleMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  let running: Promise<void> | undefined;
  const tick = async () => {
    const [clock] = await database.execute(sql`SELECT now() AS time`);
    const currentTime = z.coerce.date().parse(clock?.time).getTime();
    const claims = await database.transaction(async (db) => {
      const due = await db.execute(
        sql`SELECT * FROM broadcast_schedule WHERE state='scheduled' AND starts_at<=now() AND next_attempt_at<=now() AND (leased_until IS NULL OR leased_until<=now()) ORDER BY starts_at FOR UPDATE SKIP LOCKED LIMIT 10`,
      );
      const result: ScheduleRow[] = [];
      for (const value of due) {
        const s = scheduleRowSchema.parse(value);
        if (s.attempts >= 5) {
          await requestBroadcastStop(
            db,
            await getBroadcast(db, s.broadcast_id, true),
            "SCHEDULE_RETRIES_EXHAUSTED",
          );
          await db.execute(
            sql`UPDATE schedule_attempt SET state='expired',ended_at=now() WHERE schedule_id=${s.id} AND state='claimed'`,
          );
          await transitionSchedule(db, s, "failed", "SCHEDULE_RETRIES_EXHAUSTED");
          continue;
        }

        await db.execute(
          sql`UPDATE schedule_attempt SET state='expired',ended_at=now() WHERE schedule_id=${s.id} AND state='claimed'`,
        );
        const [row] = await db.execute(
          sql`UPDATE broadcast_schedule SET fence=fence+1,attempts=attempts+1,lease_token=${secret()},leased_until=now()+interval '15 seconds' WHERE id=${s.id} RETURNING *`,
        );
        const claimed = scheduleRowSchema.parse(row);
        await db.execute(
          sql`INSERT INTO schedule_attempt(schedule_id,fence,lease_token,state) VALUES(${s.id},${claimed.fence},${claimed.lease_token},'claimed')`,
        );
        result.push(claimed);
      }
      return result;
    });
    for (const claim of claims) {
      try {
        await database.transaction(async (db) => {
          const initial = await getSchedule(db, claim.id);
          await executionAuthority(db, initial);
          await getStream(db, initial.stream_id, true);
          const s = await getSchedule(db, claim.id, true);
          const [executionClock] = await db.execute(sql`SELECT clock_timestamp() AS time`);
          const executionTime = z.coerce.date().parse(executionClock?.time).getTime();
          if (
            s.state !== "scheduled" ||
            s.fence !== claim.fence ||
            s.lease_token !== claim.lease_token ||
            !s.leased_until ||
            s.leased_until.getTime() <= executionTime
          )
            return;
          const run = await getBroadcast(db, s.broadcast_id, true);
          if (
            executionTime > s.starts_at.getTime() + s.catch_up_seconds * 1000 + 2000 ||
            executionTime >= s.ends_at.getTime()
          ) {
            await requestBroadcastStop(db, run, "SCHEDULE_START_MISSED");
            await transitionSchedule(db, s, "missed", "SCHEDULE_START_MISSED");
            await db.execute(
              sql`UPDATE schedule_attempt SET state='missed',reason='SCHEDULE_START_MISSED',ended_at=now() WHERE schedule_id=${s.id} AND fence=${s.fence}`,
            );
            return;
          }
          if (!config.broadcastsEnabled)
            throw new ApiError(503, "BROADCASTS_DISABLED", "Broadcast admission is disabled.");
          // Never extend the original absolute source deadline after downtime or retries.
          const deadline = Math.min(
            s.ends_at.getTime(),
            executionTime + s.source_wait_seconds * 1000,
          );
          await db.execute(
            sql`UPDATE broadcast_schedule SET source_deadline=${new Date(deadline).toISOString()} WHERE id=${s.id}`,
          );
          const wait = Math.max(1, Math.min(600, Math.floor((deadline - executionTime) / 1000)));
          await db.execute(
            sql`UPDATE broadcast_run SET wait_timeout_seconds=${Math.max(10, wait)},max_duration_seconds=least(max_duration_seconds,${Math.max(60, Math.floor((s.ends_at.getTime() - executionTime) / 1000))}) WHERE id=${run.id}`,
          );
          const operation = await startBroadcastRun(
            db,
            await getBroadcast(db, run.id),
            schedulerActor,
            s.operation_id,
            config,
          );
          await db.execute(
            sql`UPDATE schedule_operation SET broadcast_operation_id=${z.object({ id: z.string() }).parse(operation).id} WHERE id=${s.operation_id}`,
          );
          await transitionSchedule(db, s, "starting");
          await db.execute(
            sql`UPDATE schedule_attempt SET state='started',ended_at=now() WHERE schedule_id=${s.id} AND fence=${s.fence}`,
          );
        });
      } catch (error: unknown) {
        await database.transaction(async (db) => {
          const s = await getSchedule(db, claim.id, true);
          if (
            s.fence !== claim.fence ||
            s.state !== "scheduled" ||
            s.lease_token !== claim.lease_token
          )
            return;
          const code = error instanceof ApiError ? error.code : "SCHEDULE_EXECUTION_UNAVAILABLE";
          const retryable = [
            "BROADCAST_CAPACITY",
            "RECORDING_CAPACITY",
            "BROADCASTS_DISABLED",
            "SCHEDULE_EXECUTION_UNAVAILABLE",
          ].includes(code);
          const retry =
            retryable &&
            s.attempts < 5 &&
            currentTime <
              Math.min(
                s.ends_at.getTime(),
                s.starts_at.getTime() + s.catch_up_seconds * 1000 + 2000,
              );
          if (retry)
            await db.execute(
              sql`UPDATE broadcast_schedule SET lease_token=NULL,leased_until=NULL,last_error=${code},next_attempt_at=now()+interval '5 seconds' WHERE id=${s.id}`,
            );
          else {
            await requestBroadcastStop(db, await getBroadcast(db, s.broadcast_id, true), code);
            await transitionSchedule(db, s, "failed", code);
          }
          await db.execute(
            sql`UPDATE schedule_attempt SET state=${retry ? "retry" : "failed"},reason=${code},ended_at=now() WHERE schedule_id=${s.id} AND fence=${s.fence}`,
          );
        });
      }
    }
    await database.transaction(async (db) => {
      const rows = await db.execute(
        sql`SELECT * FROM broadcast_schedule WHERE state IN ('starting','running','ending') ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 100`,
      );
      for (const value of rows) {
        let s = scheduleRowSchema.parse(value);
        const run = await getBroadcast(db, s.broadcast_id, true);
        if (s.state === "starting" && ["live", "degraded"].includes(run.state))
          s = await transitionSchedule(db, s, "running");
        if (s.state === "starting" && currentTime >= readinessDeadline(s).getTime()) {
          await requestBroadcastStop(db, run, "SCHEDULE_SOURCE_MISSED");
          await transitionSchedule(db, s, "missed", "SCHEDULE_SOURCE_MISSED");
          continue;
        }
        if (["stopped", "failed"].includes(run.state)) {
          await transitionSchedule(
            db,
            s,
            s.started_at
              ? run.state === "failed"
                ? "failed"
                : "completed"
              : run.lastError === "SOURCE_WAIT_TIMEOUT"
                ? "missed"
                : run.state === "failed"
                  ? "failed"
                  : "missed",
            run.lastError,
          );
          continue;
        }
        if (currentTime >= s.ends_at.getTime() && s.state !== "ending") {
          await requestBroadcastStop(db, run, "SCHEDULE_ENDED");
          await revokeScheduleAccess(db, s);
          await transitionSchedule(db, s, "ending");
        }
      }
      const notifications = await db.execute(
        sql`SELECT n.id,n.schedule_id,n.version FROM schedule_notification n JOIN broadcast_schedule s ON s.id=n.schedule_id WHERE n.state='pending' AND n.due_at<=now() AND s.state='scheduled' AND n.version=s.version ORDER BY n.due_at LIMIT 50`,
      );
      for (const n of notifications) {
        const s = await getSchedule(db, String(n.schedule_id), true);
        const [pending] = await db.execute(
          sql`SELECT id FROM schedule_notification WHERE id=${String(n.id)} AND state='pending' FOR UPDATE`,
        );
        if (!pending) continue;
        if (
          s.state !== "scheduled" ||
          s.version !== Number(n.version) ||
          !config.scheduleNotificationsEnabled
        ) {
          await db.execute(
            sql`UPDATE schedule_notification SET state='cancelled' WHERE id=${String(n.id)}`,
          );
          continue;
        }
        await scheduleEvent(db, s, "schedule.reminder");
        await db.execute(
          sql`UPDATE schedule_notification SET state='emitted',emitted_at=now() WHERE id=${String(n.id)}`,
        );
      }
      await db.execute(
        sql`DELETE FROM schedule_viewer_grant WHERE expires_at<now()-interval '1 day'`,
      );
    });
  };
  const timer = setInterval(() => {
    running ??= tick()
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Schedule maintenance failed");
      })
      .finally(() => {
        running = undefined;
      });
  }, 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
