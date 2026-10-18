import { recordAudit } from "@relayrtc/auth/server";
import { createHash } from "node:crypto";
import { signStreamingGrant, streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import { createWebhookSecretVault } from "@relayrtc/protocol/webhook-security";
import {
  createScheduleSchema,
  updateScheduleSchema,
  scheduleCommandSchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { validate } from "../../http/validation/validate.js";
import { ApiError } from "../../http/errors/api-error.js";
import {
  authorize,
  getStream,
  conflict,
  missing,
  id,
  secret,
  idempotent,
  type Transaction,
} from "./repository.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";
import { createBroadcastRun } from "./broadcast-commands.js";
import { getBroadcast, requestBroadcastStop } from "./broadcast-service.js";
import {
  getSchedule,
  publicSchedule,
  scheduleRowSchema,
  ensureScheduleWindow,
  configureNotification,
  transitionSchedule,
  revokeScheduleAccess,
  scheduleEvent,
  publisherOpens,
  viewerOpens,
  viewerCloses,
} from "./schedule-service.js";
import { StreamingGateway, ingestPath } from "./gateway.js";

const params = z.object({ scheduleId: streamingIdSchema });
export const scheduleRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
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
  const scoped = async (db: Transaction, request: FastifyRequest, permission = "streams:read") => {
    const { scheduleId } = validate(params, request.params),
      scope = validate(streamScopeSchema, request.query);
    const initial = await getSchedule(db, scheduleId);
    if (
      (scope.projectId && scope.projectId !== initial.project_id) ||
      (scope.environmentId && scope.environmentId !== initial.environment_id)
    )
      throw missing();
    const auth = await authorize(
      db,
      principal(request),
      { projectId: initial.project_id, environmentId: initial.environment_id },
      permission,
    );
    const stream = await getStream(db, initial.stream_id, permission !== "streams:read");
    if (stream.status !== "active") throw missing();
    return { s: await getSchedule(db, scheduleId, true), stream, auth };
  };
  app.post("/scheduled-broadcasts", async (request, reply) => {
    const input = validate(createScheduleSchema, request.body),
      query = validate(streamScopeSchema, request.query),
      p = principal(request);
    const projectId = query.projectId ?? (p.type === "key" ? p.key.projectId : undefined),
      environmentId = query.environmentId ?? (p.type === "key" ? p.key.environmentId : undefined);
    if (!projectId || !environmentId)
      throw new ApiError(400, "SCOPE_REQUIRED", "Select a project and environment.");
    const result = await database.transaction(async (db) => {
      const scope = { projectId, environmentId },
        auth = await authorize(db, p, scope, "streams:write");
      return command(db, request, input, 201, async () => {
        if (
          Date.parse(input.timing.startsAt) < Date.now() + 10000 ||
          Date.parse(input.timing.startsAt) > Date.now() + 366 * 86400000
        )
          throw new ApiError(
            400,
            "SCHEDULE_START_INVALID",
            "Schedule a UTC start at least ten seconds and at most one year ahead.",
          );
        await db.execute(sql`SELECT pg_advisory_xact_lock(810037)`);
        const [counts] = await db.execute(
          sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE environment_id=${environmentId})::int AS environment FROM broadcast_schedule WHERE state IN ('scheduled','starting','running','ending')`,
        );
        if (
          Number(counts?.total) >= config.maxSchedules ||
          Number(counts?.environment) >= config.maxSchedulesPerEnvironment
        )
          throw conflict("SCHEDULE_CAPACITY", "Schedule capacity is full.");
        const stream = await getStream(db, input.broadcast.streamId, true);
        if (
          stream.projectId !== projectId ||
          stream.environmentId !== environmentId ||
          stream.status !== "active"
        )
          throw missing();
        await ensureScheduleWindow(db, stream.id, input.timing);
        const duration =
          (Date.parse(input.timing.endsAt) - Date.parse(input.timing.startsAt)) / 1000;
        if (
          duration < 60 ||
          duration > Math.min(input.broadcast.maxDurationSeconds, stream.maxDurationSeconds)
        )
          throw new ApiError(
            400,
            "SCHEDULE_DURATION_INVALID",
            "The schedule must last at least a minute and fit the broadcast and stream duration limits.",
          );
        const run = await createBroadcastRun(
          db,
          input.broadcast,
          scope,
          auth.organizationId,
          auth.actor,
          request.id,
          config,
        );
        if (run.snapshot.recording) await authorize(db, p, scope, "recordings:create");
        const scheduleId = id("schedule"),
          operationId = id("scop"),
          t = input.timing;
        const [row] = await db.execute(
          sql`INSERT INTO broadcast_schedule(id,stream_id,broadcast_id,operation_id,organization_id,project_id,environment_id,name,creator_type,creator_id,starts_at,ends_at,time_zone,source_wait_seconds,catch_up_seconds,publisher_early_seconds,viewer_early_seconds,viewer_after_seconds,notify_before_seconds) VALUES(${scheduleId},${stream.id},${run.id},${operationId},${auth.organizationId},${projectId},${environmentId},${run.name},${p.type},${p.type === "key" ? p.key.keyId : p.userId},${t.startsAt},${t.endsAt},${t.timeZone},${t.sourceWaitSeconds},${t.catchUpSeconds},${t.publisherEarlySeconds},${t.viewerEarlySeconds},${t.viewerAfterSeconds},${t.notifyBeforeSeconds}) RETURNING *`,
        );
        await db.execute(
          sql`INSERT INTO schedule_operation(id,schedule_id,broadcast_id) VALUES(${operationId},${scheduleId},${run.id})`,
        );
        const s = scheduleRowSchema.parse(row);
        await configureNotification(db, s, config);
        await scheduleEvent(db, s, "schedule.created", auth.actor);
        return publicSchedule(s);
      });
    });
    return reply.code(201).send(result);
  });
  app.get("/scheduled-broadcasts", (request) =>
    database.transaction(async (db) => {
      const query = validate(
          streamScopeSchema.extend({
            cursor: streamingIdSchema.optional(),
            streamId: streamingIdSchema.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(30),
            state: scheduleRowSchema.shape.state.optional(),
          }),
          request.query,
        ),
        p = principal(request);
      const projectId = query.projectId ?? (p.type === "key" ? p.key.projectId : undefined),
        environmentId = query.environmentId ?? (p.type === "key" ? p.key.environmentId : undefined);
      if (!projectId || !environmentId)
        throw new ApiError(400, "SCOPE_REQUIRED", "Select a project and environment.");
      await authorize(db, p, { projectId, environmentId }, "streams:read");
      const rows = await db.execute(
        sql`SELECT * FROM broadcast_schedule WHERE project_id=${projectId} AND environment_id=${environmentId} ${query.streamId ? sql`AND stream_id=${query.streamId}` : sql``} ${query.cursor ? sql`AND id>${query.cursor}` : sql``} ${query.state ? sql`AND state=${query.state}` : sql``} ORDER BY id LIMIT ${query.limit + 1}`,
      );
      const [count] = await db.execute(
        sql`SELECT count(*)::int AS total FROM broadcast_schedule WHERE project_id=${projectId} AND environment_id=${environmentId} AND state IN ('scheduled','starting','running','ending')`,
      );
      return {
        data: rows.slice(0, query.limit).map((row) => publicSchedule(scheduleRowSchema.parse(row))),
        nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?.id) : null,
        limits: {
          activeSchedules: Number(count?.total),
          maxActiveSchedules: config.maxSchedulesPerEnvironment,
        },
      };
    }),
  );
  app.get("/scheduled-broadcasts/:scheduleId", (request) =>
    database.transaction(async (db) => publicSchedule((await scoped(db, request)).s)),
  );
  app.get("/schedule-operations/:operationId", (request) =>
    database.transaction(async (db) => {
      const { operationId } = validate(
        z.object({ operationId: streamingIdSchema }),
        request.params,
      );
      const [op] = await db.execute(
        sql`SELECT id,schedule_id AS "scheduleId",broadcast_id AS "broadcastId",broadcast_operation_id AS "broadcastOperationId",status,error_code AS "errorCode",created_at AS "createdAt",completed_at AS "completedAt" FROM schedule_operation WHERE id=${operationId}`,
      );
      if (!op) throw missing();
      const s = await getSchedule(db, String(op.scheduleId)),
        q = validate(streamScopeSchema, request.query);
      if (
        (q.projectId && q.projectId !== s.project_id) ||
        (q.environmentId && q.environmentId !== s.environment_id)
      )
        throw missing();
      await authorize(
        db,
        principal(request),
        { projectId: s.project_id, environmentId: s.environment_id },
        "streams:read",
      );
      return op;
    }),
  );
  const change = (now: boolean) => async (request: FastifyRequest) => {
    const input = now
      ? validate(scheduleCommandSchema, request.body)
      : validate(updateScheduleSchema, request.body);
    return database.transaction(async (db) => {
      const { s, stream, auth } = await scoped(db, request, "streams:write");
      return command(db, request, input, now ? 202 : 200, async () => {
        if (input.version !== s.version)
          throw conflict("SCHEDULE_VERSION_CONFLICT", "Reload the schedule before changing it.");
        if (s.state !== "scheduled")
          throw conflict(
            "SCHEDULE_NOT_EDITABLE",
            "Only a schedule that has not started can be changed.",
          );
        const duration = s.ends_at.getTime() - s.starts_at.getTime();
        const t = !now
          ? updateScheduleSchema.parse(input).timing
          : {
              ...publicSchedule(s),
              startsAt: new Date().toISOString(),
              endsAt: new Date(Date.now() + duration).toISOString(),
            };
        if (
          !now &&
          (Date.parse(t.startsAt) < Date.now() + 10000 ||
            Date.parse(t.startsAt) > Date.now() + 366 * 86400000)
        )
          throw new ApiError(
            400,
            "SCHEDULE_START_INVALID",
            "Choose a future UTC start within one year.",
          );
        const run = await getBroadcast(db, s.broadcast_id, true);
        if (
          (Date.parse(t.endsAt) - Date.parse(t.startsAt)) / 1000 < 60 ||
          (Date.parse(t.endsAt) - Date.parse(t.startsAt)) / 1000 >
            Math.min(run.maxDurationSeconds, stream.maxDurationSeconds)
        )
          throw conflict(
            "SCHEDULE_DURATION_INVALID",
            "Keep the event within the saved broadcast duration limit.",
          );
        await ensureScheduleWindow(db, stream.id, t, s.id);
        await revokeScheduleAccess(db, s);
        await db.execute(
          sql`UPDATE schedule_operation SET status='cancelled',error_code='SCHEDULE_RESCHEDULED',completed_at=now() WHERE id=${s.operation_id} AND status='pending'`,
        );
        await db.execute(
          sql`UPDATE schedule_attempt SET state='cancelled',reason='SCHEDULE_RESCHEDULED',ended_at=now() WHERE schedule_id=${s.id} AND state='claimed'`,
        );
        const operationId = id("scop");
        await db.execute(
          sql`INSERT INTO schedule_operation(id,schedule_id,broadcast_id) VALUES(${operationId},${s.id},${s.broadcast_id})`,
        );
        const [row] = await db.execute(
          sql`UPDATE broadcast_schedule SET operation_id=${operationId},version=version+1,grant_epoch=grant_epoch+1,fence=fence+1,lease_token=NULL,leased_until=NULL,attempts=0,last_error=NULL,source_deadline=NULL,next_attempt_at=now(),starts_at=${t.startsAt},ends_at=${t.endsAt},time_zone=${t.timeZone},source_wait_seconds=${t.sourceWaitSeconds},catch_up_seconds=${t.catchUpSeconds},publisher_early_seconds=${t.publisherEarlySeconds},viewer_early_seconds=${t.viewerEarlySeconds},viewer_after_seconds=${t.viewerAfterSeconds},notify_before_seconds=${now ? null : t.notifyBeforeSeconds},updated_at=now() WHERE id=${s.id} RETURNING *`,
        );
        const updated = scheduleRowSchema.parse(row);
        await configureNotification(db, updated, config);
        await scheduleEvent(db, updated, "schedule.updated", auth.actor);
        return publicSchedule(updated);
      });
    });
  };
  app.patch("/scheduled-broadcasts/:scheduleId", change(false));
  app.post("/scheduled-broadcasts/:scheduleId/start-now", async (request, reply) =>
    reply.code(202).send(await change(true)(request)),
  );
  app.post("/scheduled-broadcasts/:scheduleId/cancel", (request) => {
    const input = validate(scheduleCommandSchema, request.body);
    return database.transaction(async (db) => {
      const { s, auth } = await scoped(db, request, "streams:write");
      return command(db, request, input, 200, async () => {
        if (s.state === "cancelled") return publicSchedule(s);
        if (s.version !== input.version)
          throw conflict("SCHEDULE_VERSION_CONFLICT", "Reload the schedule before cancelling it.");
        if (["completed", "missed", "failed"].includes(s.state))
          throw conflict("SCHEDULE_TERMINAL", "This schedule has already ended.");
        await requestBroadcastStop(
          db,
          await getBroadcast(db, s.broadcast_id, true),
          "SCHEDULE_CANCELLED",
        );
        await db.execute(
          sql`UPDATE broadcast_schedule SET grant_epoch=grant_epoch+1,fence=fence+1 WHERE id=${s.id}`,
        );
        await db.execute(
          sql`UPDATE schedule_attempt SET state='cancelled',reason='SCHEDULE_CANCELLED',ended_at=now() WHERE schedule_id=${s.id} AND state='claimed'`,
        );
        return publicSchedule(
          await transitionSchedule(db, s, "cancelled", "SCHEDULE_CANCELLED", auth.actor),
        );
      });
    });
  });
  app.get("/scheduled-broadcasts/:scheduleId/playback", (request) =>
    database.transaction(async (db) => {
      const { s } = await scoped(db, request),
        run = await getBroadcast(db, s.broadcast_id);
      const open = viewerOpens(s),
        close = viewerCloses(s);
      if (Date.now() < open.getTime() || Date.now() >= close.getTime())
        throw new ApiError(
          403,
          "SCHEDULE_VIEWER_WINDOW_CLOSED",
          "The event viewer access window is closed.",
        );
      const live =
        s.state === "running" &&
        run.desiredState === "running" &&
        ["live", "degraded", "reconnecting"].includes(run.state);
      return {
        scheduleId: s.id,
        streamId: s.stream_id,
        broadcastId: s.broadcast_id,
        state: live
          ? "live"
          : s.state === "scheduled"
            ? "ready"
            : s.state === "starting"
              ? "starting"
              : ["failed", "missed"].includes(s.state)
                ? "failed"
                : "ended",
        scheduleState: s.state,
        sourceSessionId: live ? run.sourceSessionId : null,
        generation: live ? run.sourceGeneration : null,
        startsAt: s.starts_at.toISOString(),
        endsAt: s.ends_at.toISOString(),
        serverTime: new Date().toISOString(),
        countdownSeconds: Math.max(0, Math.ceil((s.starts_at.getTime() - Date.now()) / 1000)),
        publisherOpensAt: publisherOpens(s).toISOString(),
        viewerOpensAt: open.toISOString(),
        viewerClosesAt: close.toISOString(),
      };
    }),
  );
  app.post("/scheduled-broadcasts/:scheduleId/playback-grants", (request) => {
    const input = validate(
      z.object({ ttlSeconds: z.number().int().min(30).max(3600).default(300) }).strict(),
      request.body ?? {},
    );
    return database.transaction(async (db) => {
      const { s, stream, auth } = await scoped(db, request, "streams:playback");
      return command(db, request, input, 201, async () => {
        const run = await getBroadcast(db, s.broadcast_id);
        if (
          s.state !== "running" ||
          run.desiredState !== "running" ||
          !["live", "degraded"].includes(run.state) ||
          !run.sourceSessionId ||
          Date.now() < viewerOpens(s).getTime()
        )
          throw conflict(
            "SCHEDULE_PLAYBACK_NOT_LIVE",
            "Wait for this scheduled broadcast to become live.",
          );
        const ttl = Math.min(
          input.ttlSeconds,
          Math.floor(
            (Math.min(s.ends_at.getTime(), viewerCloses(s).getTime()) - Date.now()) / 1000,
          ),
        );
        if (ttl < 1) throw conflict("SCHEDULE_VIEWER_WINDOW_CLOSED", "Viewer access has ended.");
        const grantId = id("sview"),
          token = signStreamingGrant(
            config.secret,
            {
              aud: "streaming-playback",
              sub: grantId,
              streamId: stream.id,
              sessionId: run.sourceSessionId,
              generation: stream.playbackEpoch,
              action: "read",
            },
            ttl,
          ),
          expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        await db.execute(
          sql`INSERT INTO schedule_viewer_grant(id,schedule_id,token_hash,epoch,expires_at) VALUES(${grantId},${s.id},${streamingSecretHash(token)},${s.grant_epoch},${expiresAt})`,
        );
        await recordAudit(db, {
          actor: auth.actor,
          action: "schedule.playback.granted",
          outcome: "SUCCESS",
          organizationId: s.organization_id,
          resourceType: "schedule",
          resourceId: s.id,
          correlationId: request.id,
        });
        return {
          token,
          url: `${config.publicOrigin}/v1/playback/${stream.id}/${run.sourceSessionId}/index.m3u8?token=${encodeURIComponent(token)}`,
          expiresAt,
        };
      });
    });
  });
  const vault = createWebhookSecretVault(
    createHash("sha256").update(config.secret).digest("base64"),
  );
  app.post("/scheduled-broadcasts/:scheduleId/ingest-credentials", async (request, reply) => {
    validate(z.object({}).strict(), request.body ?? {});
    const result = await database.transaction(async (db) => {
      const { s, stream, auth } = await scoped(db, request, "streams:publish");
      return command(db, request, {}, 201, async () => {
        if (
          !["scheduled", "starting", "running"].includes(s.state) ||
          Date.now() >= s.ends_at.getTime() ||
          stream.source.kind === "room"
        )
          throw conflict(
            "SCHEDULE_INGEST_UNAVAILABLE",
            "This schedule does not accept external ingest credentials.",
          );
        const [count] = await db.execute(
          sql`SELECT count(*)::int AS n FROM streaming_ingest_credential WHERE stream_id=${stream.id} AND revoked_at IS NULL AND expires_at>now()`,
        );
        if (Number(count?.n) >= 5)
          throw conflict(
            "INGEST_CREDENTIAL_LIMIT",
            "Revoke or rotate an existing stream credential first.",
          );
        const credentialId = id("ingest"),
          value = secret(),
          expiresAt = s.ends_at.toISOString(),
          notBefore = publisherOpens(s).toISOString();
        await new StreamingGateway(config).ensurePath(ingestPath(stream.id));
        await db.execute(
          sql`INSERT INTO streaming_ingest_credential(id,stream_id,secret_hash,expires_at,not_before,schedule_id) VALUES(${credentialId},${stream.id},${streamingSecretHash(value)},${expiresAt},${notBefore},${s.id})`,
        );
        await recordAudit(db, {
          actor: auth.actor,
          action: "schedule.ingest.granted",
          outcome: "SUCCESS",
          organizationId: s.organization_id,
          resourceType: "schedule",
          resourceId: s.id,
          correlationId: request.id,
        });
        return {
          id: credentialId,
          scheduleId: s.id,
          notBefore,
          expiresAt,
          protocol: stream.source.kind,
          url:
            stream.source.kind === "whip"
              ? `${config.publicOrigin}/v1/ingest/whip/${stream.id}`
              : `${config.publicRtmp.replace(/\/$/u, "")}/ingest_${stream.id}`,
          encryptedSecret: vault.encrypt(value, `schedule-ingest:${s.id}`),
        };
      });
    });
    const body = z.object({ encryptedSecret: z.string() }).loose().parse(result),
      { encryptedSecret, ...rest } = body;
    return reply.code(201).send({
      ...rest,
      secret: vault.decrypt(
        encryptedSecret,
        `schedule-ingest:${validate(params, request.params).scheduleId}`,
      ),
    });
  });
  return Promise.resolve();
};
