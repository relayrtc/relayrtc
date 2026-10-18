import { createBroadcastRun, startBroadcastRun } from "./broadcast-commands.js";
import { schema } from "@relayrtc/database";
import {
  createBroadcastSchema,
  listBroadcastsSchema,
  broadcastCommandSchema,
  streamingIdSchema,
  streamScopeSchema,
} from "@relayrtc/validation";
import { and, eq, gt, lt, or, desc, notInArray, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import { authorize, conflict, id, idempotent, missing, type Transaction } from "./repository.js";
import { registerStreamingManagementAuth } from "./management-auth.js";
import type { StreamingRoutesOptions } from "./routes.js";
import {
  broadcastAudit,
  broadcastOperation,
  broadcastUsage,
  getBroadcast,
  publicBroadcast,
  publicOutput,
  requestBroadcastStop,
} from "./broadcast-service.js";

const params = z.object({ broadcastId: streamingIdSchema });
export const broadcastRoutes: FastifyPluginAsync<StreamingRoutesOptions> = (app, options) => {
  const { database, config } = options;
  const principal = registerStreamingManagementAuth(app, options);
  const command = (
    db: Transaction,
    request: FastifyRequest,
    status: number,
    payload: unknown,
    run: () => Promise<unknown>,
  ) => {
    const actor = principal(request);
    return idempotent(
      db,
      `${actor.type === "key" ? actor.key.keyId : actor.userId}:${request.method}:${request.url}`,
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : undefined,
      payload,
      status,
      run,
    );
  };
  const enabled = () => {
    if (!config.broadcastsEnabled)
      throw new ApiError(
        503,
        "BROADCASTS_DISABLED",
        "Broadcast admission is disabled; existing runs are being drained",
      );
  };
  const scopeFor = (request: FastifyRequest) => {
    const query = validate(streamScopeSchema, request.query),
      actor = principal(request);
    const projectId = query.projectId ?? (actor.type === "key" ? actor.key.projectId : undefined);
    const environmentId =
      query.environmentId ?? (actor.type === "key" ? actor.key.environmentId : undefined);
    if (!projectId || !environmentId)
      throw new ApiError(400, "SCOPE_REQUIRED", "Select a project and environment");
    return { projectId, environmentId };
  };
  const authorized = async (db: Transaction, request: FastifyRequest, permission: string) => {
    const { broadcastId } = validate(params, request.params),
      scope = validate(streamScopeSchema, request.query);
    const initial = await getBroadcast(db, broadcastId);
    if (
      (scope.projectId && scope.projectId !== initial.projectId) ||
      (scope.environmentId && scope.environmentId !== initial.environmentId)
    )
      throw missing();
    const auth = await authorize(db, principal(request), initial, permission);
    const run = await getBroadcast(db, initial.id, true);
    return { run, auth };
  };
  app.post("/broadcasts", async (request, reply) => {
    enabled();
    const input = validate(createBroadcastSchema, request.body),
      scope = scopeFor(request);
    const result = await database.transaction(async (db) => {
      const auth = await authorize(db, principal(request), scope, "streams:write");
      return command(db, request, 201, { input, scope }, async () => {
        return publicBroadcast(
          await createBroadcastRun(
            db,
            input,
            scope,
            auth.organizationId,
            auth.actor,
            request.id,
            config,
          ),
        );
      });
    });
    return reply.code(201).send(result);
  });
  app.get("/broadcasts", (request) =>
    database.transaction(async (db) => {
      const query = validate(listBroadcastsSchema, request.query),
        scope = scopeFor(request);
      await authorize(db, principal(request), scope, "streams:read");
      const cursor =
        query.order === "newest" && query.cursor
          ? (
              await db
                .select({ id: schema.broadcastRun.id, createdAt: schema.broadcastRun.createdAt })
                .from(schema.broadcastRun)
                .where(
                  and(
                    eq(schema.broadcastRun.id, query.cursor),
                    eq(schema.broadcastRun.projectId, scope.projectId),
                    eq(schema.broadcastRun.environmentId, scope.environmentId),
                    query.streamId ? eq(schema.broadcastRun.streamId, query.streamId) : undefined,
                  ),
                )
                .limit(1)
            )[0]
          : null;
      if (query.order === "newest" && query.cursor && !cursor) throw missing();
      const rows = await db
        .select()
        .from(schema.broadcastRun)
        .where(
          and(
            eq(schema.broadcastRun.projectId, scope.projectId),
            eq(schema.broadcastRun.environmentId, scope.environmentId),
            query.order === "newest"
              ? cursor
                ? or(
                    lt(schema.broadcastRun.createdAt, cursor.createdAt),
                    and(
                      eq(schema.broadcastRun.createdAt, cursor.createdAt),
                      lt(schema.broadcastRun.id, cursor.id),
                    ),
                  )
                : undefined
              : query.cursor
                ? gt(schema.broadcastRun.id, query.cursor)
                : undefined,
            query.activeOnly === "true"
              ? and(
                  eq(schema.broadcastRun.desiredState, "running"),
                  notInArray(schema.broadcastRun.state, ["stopping", "stopped", "failed"]),
                )
              : undefined,
            query.streamId ? eq(schema.broadcastRun.streamId, query.streamId) : undefined,
            query.state ? eq(schema.broadcastRun.state, query.state) : undefined,
          ),
        )
        .orderBy(
          ...(query.order === "newest"
            ? [desc(schema.broadcastRun.createdAt), desc(schema.broadcastRun.id)]
            : [schema.broadcastRun.id]),
        )
        .limit(query.limit + 1);
      return {
        data: rows.slice(0, query.limit).map(publicBroadcast),
        nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null,
        limits: await (async () => {
          const [active] = await db.execute(
            sql`SELECT count(*)::int AS value FROM broadcast_run WHERE project_id=${scope.projectId} AND environment_id=${scope.environmentId} AND (desired_state='running' OR state='stopping')`,
          );
          const [reserved] = await db.execute(
            sql`SELECT count(*)::int AS value FROM broadcast_reservation r JOIN broadcast_job j ON j.id=r.job_id JOIN broadcast_run b ON b.id=j.broadcast_id WHERE b.project_id=${scope.projectId} AND b.environment_id=${scope.environmentId}`,
          );
          return {
            activeRuns: Number(active?.value ?? 0),
            maxActiveRuns: config.maxBroadcastsPerEnvironment,
            reservedOutputs: Number(reserved?.value ?? 0),
          };
        })(),
      };
    }),
  );
  app.get("/broadcasts/:broadcastId", (request) =>
    database.transaction(async (db) => {
      const { run } = await authorized(db, request, "streams:read");
      return { ...publicBroadcast(run), usage: broadcastUsage(run) };
    }),
  );
  app.get("/broadcasts/:broadcastId/outputs", (request) =>
    database.transaction(async (db) => {
      const { run } = await authorized(db, request, "streams:read");
      const outputs = await db
        .select()
        .from(schema.broadcastOutput)
        .where(eq(schema.broadcastOutput.broadcastId, run.id));
      const jobs = await db
        .select()
        .from(schema.broadcastJob)
        .where(eq(schema.broadcastJob.broadcastId, run.id));
      return {
        data: outputs.map((output) => {
          const job = jobs.find((item) => item.outputId === output.id);
          return job
            ? publicOutput(
                job,
                output.destinationId,
                typeof output.configuration.name === "string" ? output.configuration.name : null,
              )
            : {
                id: output.id,
                broadcastId: run.id,
                kind: output.kind,
                destinationId: output.destinationId,
                destinationName:
                  typeof output.configuration.name === "string" ? output.configuration.name : null,
                outputSeconds: 0,
                bytes: 0,
                bitrate: 0,
                droppedFrames: 0,
                transcodeSeconds: 0,
                state: "queued",
                attempts: 0,
                fence: 0,
                lastError: null,
                lastHeartbeatAt: null,
                sourceSessionId: null,
                sourceGeneration: null,
              };
        }),
      };
    }),
  );
  app.post("/broadcasts/:broadcastId/start", async (request, reply) => {
    enabled();
    const input = validate(broadcastCommandSchema, request.body ?? {});
    const result = await database.transaction(async (db) => {
      const { run, auth } = await authorized(db, request, "streams:write");
      return command(db, request, 202, input, async () => {
        if (input.version !== undefined && input.version !== run.version)
          throw conflict(
            "BROADCAST_VERSION_CONFLICT",
            "Reload the broadcast before issuing this command",
          );
        const [scheduled] = await db.execute(
          sql`SELECT id FROM broadcast_schedule WHERE broadcast_id=${run.id}`,
        );
        if (scheduled)
          throw conflict(
            "BROADCAST_SCHEDULE_MANAGED",
            "Use the schedule start-now command for this broadcast.",
          );
        if (run.snapshot.recording)
          await authorize(db, principal(request), run, "recordings:create");
        return startBroadcastRun(db, run, auth.actor, request.id, config);
      });
    });
    return reply.code(202).send(result);
  });
  app.post("/broadcasts/:broadcastId/stop", async (request, reply) => {
    const input = validate(broadcastCommandSchema, request.body ?? {});
    const result = await database.transaction(async (db) => {
      const { run, auth } = await authorized(db, request, "streams:write");
      return command(db, request, 202, input, async () => {
        if (input.version !== undefined && input.version !== run.version)
          throw conflict(
            "BROADCAST_VERSION_CONFLICT",
            "Reload the broadcast before issuing this command",
          );
        await db
          .update(schema.broadcastRun)
          .set({ correlationId: request.id })
          .where(eq(schema.broadcastRun.id, run.id));
        await requestBroadcastStop(db, { ...run, correlationId: request.id });
        await broadcastAudit(db, run, auth.actor, "broadcast.stop.requested", request.id);
        return broadcastOperation(db, run, "broadcast.stop");
      });
    });
    return reply.code(202).send(result);
  });
  app.post("/broadcasts/:broadcastId/outputs/:outputId/retry", async (request, reply) => {
    enabled();
    const input = validate(broadcastCommandSchema, request.body ?? {});
    const { outputId } = validate(z.object({ outputId: streamingIdSchema }), request.params);
    const result = await database.transaction(async (db) => {
      const { run, auth } = await authorized(db, request, "streams:write");
      return command(db, request, 202, input, async () => {
        if (input.version !== undefined && input.version !== run.version)
          throw conflict("BROADCAST_VERSION_CONFLICT", "Reload the broadcast before retrying.");
        if (run.desiredState !== "running" || ["stopping", "stopped", "failed"].includes(run.state))
          throw conflict("BROADCAST_NOT_RUNNING", "Only outputs of an active run can retry.");
        const [job] = await db
          .select()
          .from(schema.broadcastJob)
          .where(
            and(
              eq(schema.broadcastJob.outputId, outputId),
              eq(schema.broadcastJob.broadcastId, run.id),
            ),
          )
          .for("update");
        if (!job) throw missing();
        if (job.leasedUntil || !["failed", "retry"].includes(job.state))
          throw conflict(
            "OUTPUT_NOT_RETRYABLE",
            "The output must finish its current attempt before retrying.",
          );
        if (
          job.manualRetries >= 5 ||
          (job.lastHeartbeatAt && Date.now() - job.lastHeartbeatAt.getTime() < 10000)
        )
          throw new ApiError(
            429,
            "OUTPUT_RETRY_LIMIT",
            "Wait before retrying; each output allows five manual retry cycles.",
          );
        if (job.kind === "rtmp" && run.egressBytes >= config.maxEgressBytes)
          throw conflict("EGRESS_BYTE_LIMIT", "The run egress byte allowance is exhausted.");
        await db
          .update(schema.broadcastJob)
          .set({
            state: "retry",
            desiredState: "running",
            attempts: 0,
            manualRetries: job.manualRetries + 1,
            fence: job.fence + 1,
            lastError: null,
            availableAt: new Date(),
          })
          .where(eq(schema.broadcastJob.id, job.id));
        await broadcastAudit(db, run, auth.actor, "broadcast.output.retry", request.id);
        const [operation] = await db
          .insert(schema.streamingOperation)
          .values({
            id: id("sop"),
            streamId: run.streamId,
            broadcastId: run.id,
            outputId,
            kind: "broadcast.output.retry",
          })
          .returning();
        return operation;
      });
    });
    return reply.code(202).send(result);
  });
  return Promise.resolve();
};
