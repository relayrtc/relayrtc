import { randomBytes, randomUUID } from "node:crypto";
import { recordAudit, type AuditActor } from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import type { StreamResource } from "@relayrtc/types";
import { streamProfileSchema, streamSourceSchema } from "@relayrtc/validation";
import { eq, sql } from "drizzle-orm";
import type { ApiKeyPrincipal } from "../../authentication/api-key-authenticator.js";
import { ApiError } from "../../http/errors/api-error.js";

export type Transaction = Parameters<Parameters<RelayKitDatabase["transaction"]>[0]>[0];
export type StreamRow = typeof schema.streamingStream.$inferSelect;
export type SessionRow = typeof schema.streamingSession.$inferSelect;
export type Principal = { type: "key"; key: ApiKeyPrincipal } | { type: "user"; userId: string };
export interface Scope {
  projectId: string;
  environmentId: string;
}
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const secret = () => randomBytes(32).toString("base64url");
export const missing = () =>
  new ApiError(404, "RESOURCE_NOT_FOUND", "The requested streaming resource was not found");
export const conflict = (code: string, description: string) => new ApiError(409, code, description);
export function publicStream(row: StreamRow): StreamResource {
  return {
    ...row,
    source: streamSourceSchema.parse(row.source),
    profile: streamProfileSchema.parse(row.profile),
    status: row.status as StreamResource["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function publicSession(row: SessionRow) {
  return {
    id: row.id,
    streamId: row.streamId,
    state: row.state,
    desiredState: row.desiredState,
    generation: row.generation,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    sourceInfo: row.sourceInfo,
    ingressBitrate: row.ingressBitrate,
    programBitrate: row.programBitrate,
  };
}
export async function getStream(
  db: Transaction,
  streamId: string,
  lock = false,
): Promise<StreamRow> {
  const query = db
    .select()
    .from(schema.streamingStream)
    .where(eq(schema.streamingStream.id, streamId));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw missing();
  return row;
}
export async function authorize(
  db: Transaction,
  principal: Principal,
  scope: Scope,
  permission: string,
): Promise<{ organizationId: string; actor: AuditActor }> {
  const [owner] =
    await db.execute(sql`SELECT p.organization_id FROM project p JOIN environment e ON e.project_id=p.id JOIN organization o ON o.id=p.organization_id
    WHERE p.id=${scope.projectId} AND e.id=${scope.environmentId} AND p.status='active' AND e.status='active' AND o.status='active' FOR SHARE OF p,e,o`);
  if (!owner) throw missing();
  const organizationId = String(owner.organization_id);
  if (principal.type === "key") {
    const key = principal.key;
    if (
      key.keyType !== "secret" ||
      key.projectId !== scope.projectId ||
      key.environmentId !== scope.environmentId ||
      !key.scopes.includes(permission)
    )
      throw new ApiError(
        403,
        "STREAM_SCOPE_REQUIRED",
        `A scoped secret key with ${permission} is required`,
      );
    const [stored] =
      await db.execute(sql`SELECT name FROM api_key WHERE id=${key.keyId} AND type='secret' AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) AND ${permission}=ANY(scopes) FOR SHARE`);
    if (!stored)
      throw new ApiError(401, "INVALID_API_KEY", "The API key has expired or was revoked");
    return { organizationId, actor: { type: "API_KEY", id: key.keyId, name: String(stored.name) } };
  }
  const [member] =
    await db.execute(sql`SELECT m.role,u.name FROM member m JOIN "user" u ON u.id=m.user_id
    WHERE m.organization_id=${organizationId} AND m.user_id=${principal.userId} FOR SHARE OF m`);
  if (!member) throw missing();
  if (!permission.endsWith(":read") && member.role !== "owner" && member.role !== "admin")
    throw new ApiError(
      403,
      "STREAM_MANAGEMENT_FORBIDDEN",
      "Only organization owners and admins can manage streaming",
    );
  return {
    organizationId,
    actor: { type: "USER", id: principal.userId, name: String(member.name) },
  };
}
export async function audit(
  db: Transaction,
  stream: StreamRow,
  actor: AuditActor,
  action: string,
  correlationId?: string,
) {
  await recordAudit(db, {
    actor,
    action,
    outcome: "SUCCESS",
    resourceType: "stream",
    resourceId: stream.id,
    organizationId: stream.organizationId,
    correlationId,
  });
}
export async function event(
  db: Transaction,
  stream: StreamRow,
  type: string,
  sessionId: string | null,
  correlationId?: string,
) {
  const eventId = id("event"),
    occurredAt = new Date().toISOString();
  const payload = {
    id: eventId,
    type,
    projectId: stream.projectId,
    environmentId: stream.environmentId,
    occurredAt,
    data: {
      streamId: stream.id,
      sourceSessionId: sessionId,
      version: stream.version,
      correlationId: correlationId ?? null,
    },
  };
  const body = JSON.stringify(payload);
  await db.execute(sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body)
    VALUES(${eventId},${eventId},${stream.projectId},${stream.environmentId},${type},${occurredAt},${body}::jsonb,${body})`);
}
export async function operation(
  db: Transaction,
  streamId: string,
  kind: "start" | "stop" | "delete",
  sessionId: string | null,
) {
  const [row] =
    await db.execute(sql`INSERT INTO streaming_operation(id,stream_id,session_id,kind) VALUES(${id("sop")},${streamId},${sessionId},${kind})
    RETURNING id,stream_id AS "streamId",session_id AS "sessionId",kind,status,error_code AS "errorCode",created_at AS "createdAt",completed_at AS "completedAt"`);
  return required(row);
}
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
};
export async function idempotent(
  db: Transaction,
  scope: string,
  key: string | undefined,
  payload: unknown,
  status: number,
  run: () => Promise<unknown>,
) {
  if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(key))
    throw new ApiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Provide a unique Idempotency-Key header for this command",
    );
  const fingerprint = streamingSecretHash(stable(payload));
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`},0))`);
  await db.execute(
    sql`DELETE FROM streaming_idempotency WHERE scope_key=${scope} AND key=${key} AND expires_at<=now()`,
  );
  const [previous] = await db.execute(
    sql`SELECT fingerprint,response FROM streaming_idempotency WHERE scope_key=${scope} AND key=${key}`,
  );
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw conflict("IDEMPOTENCY_CONFLICT", "This key was used for a different command");
    return previous.response;
  }
  const response = await run();
  await db.execute(
    sql`INSERT INTO streaming_idempotency(scope_key,key,fingerprint,response,status) VALUES(${scope},${key},${fingerprint},${JSON.stringify(response)}::jsonb,${status})`,
  );
  return response;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
