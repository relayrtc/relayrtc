import { setAuditContext, type AuditActor } from "@relayrtc/auth";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { participantAccessSchema, type roomAuditQuerySchema } from "@relayrtc/validation";
import type { UpdateParticipantAccess } from "@relayrtc/types";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import type { RoomScope } from "./room.repository.js";

type Database = Pick<RelayKitDatabase, "select" | "execute" | "insert">;

export async function readParticipantAccess(
  database: Database,
  roomId: string,
  participantId: string,
) {
  const [row] = await database
    .select()
    .from(schema.participant)
    .where(and(eq(schema.participant.roomId, roomId), eq(schema.participant.id, participantId)));
  if (!row) throw new ApiError(404, "PARTICIPANT_NOT_FOUND", "The participant does not exist");
  return participantAccessSchema.parse({
    roomId,
    participantId,
    role: ["host", "moderator"].includes(row.role) ? row.role : "participant",
    version: row.accessVersion,
    allowedPermissions: row.allowedPermissions,
  });
}

export async function updateParticipantAccess(
  database: Database,
  scope: RoomScope,
  roomId: string,
  participantId: string,
  input: UpdateParticipantAccess,
  actor: AuditActor,
  correlationId: string,
) {
  await database.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await database.execute(sql`SET LOCAL statement_timeout = '15s'`);
  const [scoped] =
    await database.execute(sql`SELECT r.id FROM room r JOIN project p ON p.id=r.project_id
    JOIN environment e ON e.id=r.environment_id AND e.project_id=p.id JOIN organization o ON o.id=p.organization_id
    WHERE r.id=${roomId} AND r.project_id=${scope.projectId} AND r.environment_id=${scope.environmentId}
    AND p.status='active' AND e.status='active' AND o.status='active' FOR SHARE OF p,e,o`);
  if (!scoped)
    throw new ApiError(404, "ROOM_NOT_FOUND", "The room does not exist in this active scope");
  await setAuditContext(database, actor, correlationId);
  try {
    const permissions =
      input.allowedPermissions === null
        ? sql`NULL::text[]`
        : sql`ARRAY[${sql.join(
            input.allowedPermissions.map((value) => sql`${value}`),
            sql`, `,
          )}]::text[]`;
    const rows =
      await database.execute(sql`SELECT update_room_participant_access(${roomId}, ${participantId},
      ${input.version}, ${input.role}, ${permissions}) AS access`);
    return participantAccessSchema.parse(rows[0]?.access);
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
      const message = current.message;
      const code = [
        "ROOM_NOT_FOUND",
        "PARTICIPANT_NOT_FOUND",
        "ROOM_NOT_JOINABLE",
        "ROOM_ACCESS_CONFLICT",
        "ROOM_HOST_TRANSFER_REQUIRED",
        "ROOM_HOST_MUST_BE_PRESENT",
        "ROOM_ACCESS_FORBIDDEN",
      ].find((value) => message.includes(value));
      if (code)
        throw new ApiError(
          code.endsWith("NOT_FOUND") ? 404 : code.endsWith("FORBIDDEN") ? 403 : 409,
          code,
          code === "ROOM_ACCESS_CONFLICT"
            ? "The access policy changed; reload it before saving"
            : "The requested room access change is unavailable",
        );
      current = current.cause;
    }
    throw error;
  }
}

export async function readRoomAudit(
  database: Database,
  scope: RoomScope,
  roomId: string,
  query: z.infer<typeof roomAuditQuerySchema>,
) {
  const [room] = await database
    .select({ id: schema.room.id })
    .from(schema.room)
    .where(
      and(
        eq(schema.room.id, roomId),
        eq(schema.room.projectId, scope.projectId),
        eq(schema.room.environmentId, scope.environmentId),
      ),
    );
  if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "The room does not exist");
  const event = schema.auditEvent;
  const conditions = [
    or(
      eq(event.roomId, roomId),
      and(eq(event.resourceType, "room"), eq(event.resourceId, roomId)),
      and(eq(event.resourceType, "runtime_operation"), eq(event.resourceId, `room.end:${roomId}`)),
    ),
  ];
  if (query.action) conditions.push(eq(event.action, query.action));
  if (query.actorId) conditions.push(eq(event.actorId, query.actorId));
  if (query.participantId)
    conditions.push(
      and(eq(event.resourceType, "participant"), eq(event.resourceId, query.participantId)),
    );
  if (query.before && query.cursor)
    conditions.push(
      or(
        sql`${event.occurredAt} < ${query.before}::timestamptz`,
        and(sql`${event.occurredAt} = ${query.before}::timestamptz`, lt(event.id, query.cursor)),
      ),
    );
  const rows = await database
    .select({
      id: event.id,
      occurredAt: sql<string>`to_char(${event.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      actorType: event.actorType,
      actorId: event.actorId,
      actorName: event.actorName,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      action: event.action,
      outcome: event.outcome,
      correlationId: event.correlationId,
      metadata: event.metadata,
    })
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.occurredAt), desc(event.id))
    .limit(query.limit + 1);
  const nodes = rows.slice(0, query.limit).map((row) => ({ ...row, occurredAt: row.occurredAt }));
  const last = nodes.at(-1);
  return {
    nodes,
    pageInfo: {
      hasNextPage: rows.length > query.limit,
      endCursor: last ? { before: last.occurredAt, cursor: last.id } : null,
    },
  };
}
