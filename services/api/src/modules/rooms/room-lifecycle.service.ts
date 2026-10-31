import { createHash, randomBytes, randomUUID } from "node:crypto";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { setAuditContext, type AuditActor } from "@relayrtc/auth";
import {
  roomLifecycleSchema,
  roomInvitationSchema,
  roomParticipantPermissionSchema,
} from "@relayrtc/validation";
import type {
  CreateRoomInvitation,
  RedeemRoomInvitation,
  UpdateRoomLifecycle,
} from "@relayrtc/types";
import { and, eq, lt, desc, sql } from "drizzle-orm";
import { ApiError } from "../../http/errors/api-error.js";
import type { RoomScope } from "./room.repository.js";
import type {
  ParticipantTokenClaims,
  ParticipantTokenSigner,
} from "../participant-tokens/participant-token.signer.js";

type Database = Pick<RelayKitDatabase, "select" | "execute" | "insert" | "update">;

export async function authorizeRoomLifecycle(
  database: Database,
  scope: RoomScope,
  roomId: string,
  actor: AuditActor,
  correlationId?: string,
) {
  await database.execute(sql`SET LOCAL lock_timeout='5s'`);
  await database.execute(sql`SET LOCAL statement_timeout='15s'`);
  const [target] = await database.execute(sql`SELECT r.id FROM room r
    JOIN project p ON p.id=r.project_id JOIN organization o ON o.id=p.organization_id
    JOIN environment e ON e.id=r.environment_id AND e.project_id=p.id
    WHERE r.id=${roomId} AND r.project_id=${scope.projectId} AND r.environment_id=${scope.environmentId}
    AND p.status='active' AND e.status='active' AND o.status='active' FOR SHARE OF p,e,o`);
  if (!target)
    throw new ApiError(404, "ROOM_NOT_FOUND", "The room does not exist in this active scope");
  await setAuditContext(database, actor, correlationId);
}

export async function readRoomLifecycle(database: Database, roomId: string) {
  const [row] = await database.execute(sql`SELECT read_room_lifecycle(${roomId}) AS policy`);
  return roomLifecycleSchema.parse(row?.policy);
}

export async function requireTokenAdmission(database: Database, roomId: string) {
  const policy = await readRoomLifecycle(database, roomId);
  if (policy.endsAt && Date.parse(policy.endsAt) <= Date.now())
    throw new ApiError(409, "ROOM_NOT_JOINABLE", "The room deadline has passed");
  if (policy.locked)
    throw new ApiError(409, "ROOM_LOCKED", "Unlock the room before issuing new participant tokens");
}

export async function updateRoomLifecycle(
  database: Database,
  roomId: string,
  input: UpdateRoomLifecycle,
) {
  try {
    const [row] = await database.execute(
      sql`SELECT update_room_lifecycle(${roomId},${input.version},${input.locked},${input.endsAt}::timestamptz) AS policy`,
    );
    return roomLifecycleSchema.parse(row?.policy);
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
      const code = ["ROOM_LIFECYCLE_CONFLICT", "ROOM_NOT_JOINABLE", "ROOM_DEADLINE_INVALID"].find(
        (value) => cause instanceof Error && cause.message.includes(value),
      );
      if (code)
        throw new ApiError(
          code === "ROOM_DEADLINE_INVALID" ? 400 : 409,
          code,
          code === "ROOM_LIFECYCLE_CONFLICT"
            ? "Reload the room policy before saving"
            : "The room deadline or state does not allow this change",
        );
      cause = cause.cause;
    }
    throw error;
  }
}

async function requireAdmission(database: Database, roomId: string) {
  const [target] =
    await database.execute(sql`SELECT r.status,r.max_participants,l.locked,extract(epoch from l.ends_at)*1000 AS deadline
    FROM room r JOIN room_lifecycle l ON l.room_id=r.id WHERE r.id=${roomId} FOR UPDATE OF r`);
  if (
    !target ||
    !["created", "active"].includes(String(target.status)) ||
    (target.deadline !== null && Number(target.deadline) <= Date.now())
  )
    throw new ApiError(409, "ROOM_NOT_JOINABLE", "The room is not accepting participants");
  if (target.locked) throw new ApiError(409, "ROOM_LOCKED", "The room is locked");
  const [count] = await database.execute(
    sql`SELECT count(*)::integer AS active FROM participant WHERE room_id=${roomId} AND left_at IS NULL AND removed_at IS NULL`,
  );
  if (Number(count?.active) >= Number(target.max_participants))
    throw new ApiError(409, "ROOM_FULL", "The room is full");
  return target;
}

const invitationView = (row: typeof schema.roomInvitation.$inferSelect) =>
  roomInvitationSchema.parse({
    id: row.id,
    roomId: row.roomId,
    identity: row.identity,
    permissions: row.permissions,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });

export async function createRoomInvitation(
  database: Database,
  roomId: string,
  input: CreateRoomInvitation,
) {
  await requireAdmission(database, roomId);
  const expiresAt = new Date(input.expiresAt);
  if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 7 * 86_400_000)
    throw new ApiError(
      400,
      "ROOM_INVITATION_EXPIRY_INVALID",
      "Invitations must expire within seven days",
    );
  const [count] = await database.execute(
    sql`SELECT count(*)::integer AS total FROM room_invitation WHERE room_id=${roomId}`,
  );
  if (Number(count?.total) >= 1000)
    throw new ApiError(409, "ROOM_INVITATION_LIMIT", "This room has reached its invitation limit");
  const secret = randomBytes(32).toString("hex");
  const [row] = await database
    .insert(schema.roomInvitation)
    .values({
      id: `rinv_${randomUUID().replaceAll("-", "")}`,
      roomId,
      secretHash: createHash("sha256").update(secret).digest("hex"),
      identity: input.identity,
      permissions: [...input.permissions],
      maxUses: input.maxUses,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("Invitation insert returned no resource");
  return { invitation: invitationView(row), secret };
}

export async function listRoomInvitations(database: Database, roomId: string, cursor?: string) {
  const rows = await database
    .select()
    .from(schema.roomInvitation)
    .where(
      and(
        eq(schema.roomInvitation.roomId, roomId),
        cursor ? lt(schema.roomInvitation.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(schema.roomInvitation.id))
    .limit(51);
  const page = rows.slice(0, 50);
  return {
    nodes: page.map(invitationView),
    pageInfo: { hasNextPage: rows.length > 50, endCursor: page.at(-1)?.id ?? null },
  };
}

export async function revokeRoomInvitation(
  database: Database,
  roomId: string,
  invitationId: string,
) {
  await database.execute(sql`SELECT id FROM room WHERE id=${roomId} FOR UPDATE`);
  const [row] = await database
    .update(schema.roomInvitation)
    .set({ revokedAt: sql`coalesce(${schema.roomInvitation.revokedAt},now())` })
    .where(
      and(eq(schema.roomInvitation.id, invitationId), eq(schema.roomInvitation.roomId, roomId)),
    )
    .returning();
  if (!row) throw new ApiError(404, "ROOM_INVITATION_NOT_FOUND", "The invitation does not exist");
  return invitationView(row);
}

export async function redeemRoomInvitation(
  database: Database,
  scope: RoomScope,
  roomId: string,
  input: RedeemRoomInvitation,
  signer: ParticipantTokenSigner,
) {
  const target = await requireAdmission(database, roomId);
  const [invite] = await database
    .select()
    .from(schema.roomInvitation)
    .where(
      and(
        eq(schema.roomInvitation.roomId, roomId),
        eq(
          schema.roomInvitation.secretHash,
          createHash("sha256").update(input.secret).digest("hex"),
        ),
      ),
    )
    .for("update");
  if (
    !invite ||
    invite.revokedAt ||
    invite.expiresAt.getTime() <= Date.now() ||
    (invite.identity && invite.identity !== input.identity)
  )
    throw new ApiError(
      403,
      "ROOM_INVITATION_UNAVAILABLE",
      "The invitation is unavailable for this identity",
    );
  const [existing] = await database
    .select()
    .from(schema.roomInvitationRedemption)
    .where(
      and(
        eq(schema.roomInvitationRedemption.invitationId, invite.id),
        eq(schema.roomInvitationRedemption.redemptionId, input.redemptionId),
      ),
    );
  let claims: ParticipantTokenClaims;
  if (existing) {
    if (
      existing.identity !== input.identity ||
      existing.claims.participantName !== input.participantName
    )
      throw new ApiError(
        409,
        "ROOM_REDEMPTION_CONFLICT",
        "The redemption ID belongs to a different request",
      );
    claims = existing.claims as unknown as ParticipantTokenClaims;
    if (Date.parse(claims.expiresAt) <= Date.now())
      throw new ApiError(409, "ROOM_REDEMPTION_EXPIRED", "This redemption has expired");
  } else {
    if (invite.uses >= invite.maxUses)
      throw new ApiError(409, "ROOM_INVITATION_EXHAUSTED", "The invitation has no remaining uses");
    const [count] = await database.execute(
      sql`SELECT count(*)::integer AS total FROM room_invitation_redemption d JOIN room_invitation i ON i.id=d.invitation_id WHERE i.room_id=${roomId}`,
    );
    if (Number(count?.total) >= 10_000)
      throw new ApiError(
        409,
        "ROOM_REDEMPTION_LIMIT",
        "This room has reached its redemption limit",
      );
    const issuedAt = new Date();
    const deadline = target.deadline === null ? Infinity : Number(target.deadline);
    claims = {
      ...scope,
      roomId,
      participantId: `participant_${randomUUID().replaceAll("-", "")}`,
      participantName: input.participantName,
      tokenId: `ptok_${randomUUID().replaceAll("-", "")}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        Math.min(issuedAt.getTime() + 900_000, invite.expiresAt.getTime(), deadline),
      ).toISOString(),
      permissions: invite.permissions.map((permission) =>
        roomParticipantPermissionSchema.parse(permission),
      ),
      metadata: {},
    };
    await database.insert(schema.roomInvitationRedemption).values({
      participantId: claims.participantId,
      invitationId: invite.id,
      redemptionId: input.redemptionId,
      identity: input.identity,
      claims: { ...claims },
    });
    await database
      .update(schema.roomInvitation)
      .set({ uses: invite.uses + 1 })
      .where(eq(schema.roomInvitation.id, invite.id));
  }
  return {
    participantId: claims.participantId,
    tokenId: claims.tokenId,
    expiresAt: claims.expiresAt,
    token: await signer.sign(claims),
  };
}
