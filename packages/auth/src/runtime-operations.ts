import { sql } from "drizzle-orm";
import type { RelayKitDatabase } from "@relayrtc/database";
import { createMediaControlToken } from "@relayrtc/protocol/media-control";
import type { RoomTerminationConfig } from "./resource-deletion.js";
import { setAuditContext } from "./audit.js";

export interface RuntimeOperationView extends Record<string, unknown> {
  id: string;
  kind: string;
  status: "pending" | "running" | "failed" | "completed";
  attempts: number;
  lastError: string | null;
  completedAt: string | null;
}

interface ClaimedOperation extends RuntimeOperationView {
  resourceId: string;
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  payload: Record<string, unknown>;
  leaseToken: string;
}

export async function getRuntimeOperation(
  database: RelayKitDatabase,
  id: string,
): Promise<RuntimeOperationView | null> {
  const rows = await database.execute<RuntimeOperationView>(sql`
    SELECT id, kind, status, attempts, last_error AS "lastError", completed_at::text AS "completedAt"
    FROM runtime_operation WHERE id = ${id}`);
  return rows[0] ?? null;
}

export async function reconcileRuntimeOperations(database: RelayKitDatabase): Promise<void> {
  await database.execute(sql`SELECT reconcile_signaling_sessions()`);
  await database.execute(sql`WITH stale AS (
    SELECT r.id FROM room r WHERE r.status IN ('ended', 'failed') AND (
      NOT EXISTS (SELECT 1 FROM runtime_operation o WHERE o.id = 'room.end:' || r.id)
      OR EXISTS (SELECT 1 FROM rtc_runtime m WHERE m.room_id = r.id AND (
        coalesce(m.state->>'Generation', '') <> '' OR coalesce((m.state->>'Allocating')::boolean, false)
        OR coalesce(m.state->'Sessions', '{}'::jsonb) <> '{}'::jsonb))
      OR EXISTS (SELECT 1 FROM participant_session s JOIN participant p ON p.id = s.participant_id
        WHERE p.room_id = r.id AND s.connection_state IN ('connecting', 'connected', 'reconnecting'))
    ) ORDER BY r.created_at FOR UPDATE SKIP LOCKED LIMIT 50
  ) UPDATE room r SET status = r.status, ended_at = coalesce(r.ended_at, now()) FROM stale WHERE r.id = stale.id`);
}

export async function terminateRoomRuntime(
  room: Record<string, unknown>,
  config: RoomTerminationConfig & { service?: "relayrtc-api" | "relayrtc-console" },
  signal?: AbortSignal,
): Promise<void> {
  const id = room.id;
  if (typeof id !== "string" || room.status !== "ended" || !room.endedAt)
    throw new Error("Invalid room cleanup payload");
  const roomId = encodeURIComponent(id);
  const mediaUrl = `${config.mediaUrl}/rooms/${roomId}`;
  const request = async (url: string, init: RequestInit) => {
    const timeout = AbortSignal.timeout(8_000);
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Runtime cleanup returned HTTP ${String(response.status)}`);
  };
  const results = await Promise.allSettled([
    request(`${config.signalingUrl}/rooms/${roomId}/end`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.internalSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(room),
    }),
    request(mediaUrl, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${createMediaControlToken(config.internalSecret, {
          service: config.service ?? "relayrtc-api",
          method: "DELETE",
          path: new URL(mediaUrl).pathname,
          authority: { kind: "room", roomId: id },
        })}`,
      },
    }),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export async function processRuntimeOperation(
  database: RelayKitDatabase,
  config: RoomTerminationConfig,
  id?: string,
  signal?: AbortSignal,
): Promise<RuntimeOperationView | null> {
  const token = crypto.randomUUID();
  const rows = await database.execute<ClaimedOperation>(sql`
    WITH candidate AS (
      SELECT id FROM runtime_operation
      WHERE (${id ?? null}::text IS NULL OR id = ${id ?? null}) AND
      ((status IN ('pending', 'failed') AND available_at <= now()) OR
       (status = 'running' AND lease_expires_at <= now()))
      ORDER BY CASE WHEN kind IN ('room.end', 'participant.remove') THEN 0 ELSE 1 END, available_at, created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE runtime_operation o SET status = 'running', attempts = attempts + 1,
      lease_token = ${token}, lease_expires_at = now() + interval '45 seconds', updated_at = now()
    FROM candidate c WHERE o.id = c.id
    RETURNING o.id, kind, resource_id AS "resourceId", organization_id AS "organizationId",
      project_id AS "projectId", environment_id AS "environmentId", payload, status, attempts,
      lease_token AS "leaseToken", last_error AS "lastError", completed_at::text AS "completedAt"`);
  const operation = rows[0];
  if (!operation) return id ? getRuntimeOperation(database, id) : null;
  try {
    const timeout = AbortSignal.timeout(20_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    deadline.throwIfAborted();
    if (operation.kind === "room.end") {
      await terminateRoomRuntime(operation.payload, config, deadline);
    } else if (operation.kind === "participant.remove") {
      const remaining = await database.execute(sql`SELECT session_id FROM participant_removal_target
        WHERE operation_id = ${operation.id} AND status <> 'completed' LIMIT 1`);
      if (remaining.length !== 0) {
        const roomId = operation.payload.roomId;
        const participantId = operation.payload.participantId;
        if (typeof roomId !== "string" || typeof participantId !== "string")
          throw new Error("Invalid participant cleanup payload");
        const response = await fetch(
          `${config.signalingUrl}/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(participantId)}/remove`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${config.internalSecret}` },
            redirect: "error",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)]),
          },
        );
        await response.body?.cancel();
        if (!response.ok)
          throw new Error(`Runtime cleanup returned HTTP ${String(response.status)}`);
      }
    }
    deadline.throwIfAborted();
    await database.transaction(async (transaction) => {
      await setAuditContext(
        transaction,
        { type: "SYSTEM", name: "Runtime operation worker" },
        operation.id,
      );
      await transaction.execute(sql`SET LOCAL lock_timeout = '3s'`);
      await transaction.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const leases = await transaction.execute(sql`SELECT id FROM runtime_operation
        WHERE id = ${operation.id} AND status = 'running' AND lease_token = ${token}
        AND lease_expires_at > now() FOR UPDATE`);
      if (leases.length === 0) return;
      if (operation.kind === "participant.remove" || operation.kind === "room.end") {
        const remaining = await transaction.execute<{
          status: string;
        }>(sql`SELECT status FROM participant_removal_target
          WHERE operation_id = ${operation.id} AND status <> 'completed'
          ORDER BY CASE WHEN status = 'failed' THEN 0 ELSE 1 END LIMIT 1`);
        if (remaining.length !== 0) {
          const failed = remaining[0]?.status === "failed";
          await transaction.execute(sql`UPDATE runtime_operation SET status = ${failed ? "failed" : "pending"},
            available_at = now() + interval '2 seconds', lease_token = NULL, lease_expires_at = NULL,
            last_error = ${failed ? "Signaling cleanup will retry before completion" : null}, updated_at = now()
            WHERE id = ${operation.id} AND lease_token = ${token}`);
          return;
        }
        if (operation.kind === "room.end") {
          await transaction.execute(
            sql`DELETE FROM rtc_runtime WHERE room_id = ${operation.resourceId}`,
          );
        }
      } else if (operation.kind !== "room.end") {
        const scope =
          operation.kind === "organization.delete"
            ? sql`organization_id = ${operation.organizationId}`
            : operation.kind === "environment.delete"
              ? sql`environment_id = ${operation.environmentId}`
              : sql`project_id = ${operation.projectId}`;
        const dependencies = await transaction.execute<{
          status: string;
        }>(sql`SELECT status FROM runtime_operation
          WHERE kind IN ('room.end', 'participant.remove') AND ${scope} AND status <> 'completed'
          ORDER BY CASE WHEN status = 'failed' THEN 0 ELSE 1 END LIMIT 1`);
        if (dependencies.length !== 0) {
          const failed = dependencies[0]?.status === "failed";
          await transaction.execute(sql`UPDATE runtime_operation SET status = ${failed ? "failed" : "pending"},
            available_at = now() + interval '5 seconds', lease_token = NULL, lease_expires_at = NULL,
            last_error = ${failed ? "Runtime cleanup will retry before deletion completes" : null}, updated_at = now()
            WHERE id = ${operation.id} AND lease_token = ${token}`);
          return;
        }
        const streaming = await transaction.execute(sql`SELECT id FROM streaming_stream
          WHERE ${scope} AND status <> 'deleted' LIMIT 1`);
        if (streaming.length !== 0) {
          await transaction.execute(sql`UPDATE runtime_operation SET status='pending', available_at=now()+interval '5 seconds',
            lease_token=NULL, lease_expires_at=NULL, last_error='Streaming cleanup is in progress', updated_at=now()
            WHERE id=${operation.id} AND lease_token=${token}`);
          return;
        }
        const broadcasts = await transaction.execute(sql`SELECT id FROM broadcast_run
          WHERE ${scope} AND state NOT IN ('stopped','failed') LIMIT 1`);
        if (broadcasts.length !== 0) {
          await transaction.execute(sql`UPDATE runtime_operation SET status='pending', available_at=now()+interval '5 seconds',
            lease_token=NULL, lease_expires_at=NULL, last_error='Broadcast cleanup is in progress', updated_at=now()
            WHERE id=${operation.id} AND lease_token=${token}`);
          return;
        }
        const recordings = await transaction.execute(sql`SELECT id FROM recording WHERE ${scope} AND state<>'deleted' LIMIT 1`);
        if (recordings.length) {
          await transaction.execute(sql`UPDATE runtime_operation SET status='pending',available_at=now()+interval '5 seconds',lease_token=NULL,lease_expires_at=NULL,last_error='Recording cleanup is in progress',updated_at=now() WHERE id=${operation.id} AND lease_token=${token}`);
          return;
        }
        const table =
          operation.kind === "organization.delete"
            ? "organization"
            : operation.kind === "project.delete"
              ? "project"
              : "environment";
        const targets = await transaction.execute<{ status: string }>(
          sql`SELECT status FROM ${sql.identifier(table)} WHERE id = ${operation.resourceId} FOR UPDATE`,
        );
        if (targets[0] && targets[0].status !== "deleting")
          throw new Error("Resource is not deleting");
        deadline.throwIfAborted();
        if (operation.kind === "organization.delete") {
          await transaction.execute(
            sql`DELETE FROM organization WHERE id = ${operation.resourceId} AND status = 'deleting'`,
          );
        } else if (operation.kind === "project.delete") {
          await transaction.execute(
            sql`DELETE FROM project WHERE id = ${operation.resourceId} AND status = 'deleting'`,
          );
        } else if (operation.kind === "environment.delete") {
          await transaction.execute(
            sql`DELETE FROM environment WHERE id = ${operation.resourceId} AND status = 'deleting'`,
          );
        } else {
          throw new Error("Unknown runtime operation");
        }
      }
      await transaction.execute(sql`UPDATE runtime_operation SET status = 'completed', completed_at = now(),
        lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = ${operation.id} AND lease_token = ${token}`);
    });
  } catch (error) {
    const delay = Math.min(300, 2 ** Math.min(operation.attempts, 9));
    const message =
      error instanceof Error && error.message.startsWith("Runtime cleanup returned HTTP ")
        ? error.message
        : "Runtime cleanup could not complete";
    await database.execute(sql`UPDATE runtime_operation SET status = 'failed', last_error = ${message},
      available_at = now() + ${delay} * interval '1 second', lease_token = NULL, lease_expires_at = NULL,
      updated_at = now() WHERE id = ${operation.id} AND status = 'running' AND lease_token = ${token}`);
  }
  return getRuntimeOperation(database, operation.id);
}
