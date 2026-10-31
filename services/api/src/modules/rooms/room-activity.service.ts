import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { roomActivitySnapshotSchema, roomActivityPolicySchema } from "@relayrtc/validation";
import type { RoomActivityPolicy } from "@relayrtc/types";
import { eq, and, sql } from "drizzle-orm";
import { ApiError } from "../../http/errors/api-error.js";

export async function readRoomActivity(database: RelayKitDatabase, roomId: string) {
  const [row] = await database.execute(sql`SELECT read_room_activity(${roomId}) AS snapshot`);
  return roomActivitySnapshotSchema.parse(row?.snapshot);
}
export async function readRoomActivityPolicy(database: RelayKitDatabase, roomId: string) {
  const [row] = await database
    .select()
    .from(schema.roomActivityPolicy)
    .where(eq(schema.roomActivityPolicy.roomId, roomId));
  if (!row) throw new ApiError(404, "ROOM_NOT_FOUND", "The room activity policy is unavailable");
  return roomActivityPolicySchema.parse({
    version: row.version,
    activityEnabled: row.activityEnabled,
    speakersEnabled: row.speakersEnabled,
    idleSeconds: row.idleSeconds,
    heartbeatSeconds: row.heartbeatSeconds,
  });
}
export async function updateRoomActivityPolicy(
  database: RelayKitDatabase,
  roomId: string,
  input: RoomActivityPolicy,
) {
  const [room] = await database.execute(
    sql`SELECT id FROM room WHERE id=${roomId} AND status IN ('created','active') FOR UPDATE`,
  );
  if (!room) throw new ApiError(409, "ROOM_NOT_JOINABLE", "The room is no longer active");
  const [policy] = await database
    .update(schema.roomActivityPolicy)
    .set({ ...input, version: input.version + 1 })
    .where(
      and(
        eq(schema.roomActivityPolicy.roomId, roomId),
        eq(schema.roomActivityPolicy.version, input.version),
      ),
    )
    .returning();
  if (!policy)
    throw new ApiError(409, "ROOM_ACTIVITY_CONFLICT", "Reload the activity policy before saving");
  if (!input.activityEnabled)
    await database.execute(sql`UPDATE participant_activity SET heartbeat_at=NULL,last_input_at=NULL
    WHERE participant_id IN(SELECT id FROM participant WHERE room_id=${roomId})`);
  if (!input.speakersEnabled)
    await database.execute(sql`DELETE FROM room_speaker_snapshot WHERE room_id=${roomId}`);
  await database.execute(sql`INSERT INTO audit_event(id,actor_type,actor_id,actor_name,organization_id,room_id,resource_type,resource_id,action,outcome,metadata)
    SELECT gen_random_uuid()::text,coalesce(nullif(current_setting('relayrtc.audit_actor_type',true),''),'SYSTEM'),
      nullif(current_setting('relayrtc.audit_actor_id',true),''),coalesce(nullif(current_setting('relayrtc.audit_actor_name',true),''),'Room administration'),
      p.organization_id,r.id,'room',r.id,'room.activity_policy_updated','SUCCESS','{}'::jsonb FROM room r JOIN project p ON p.id=r.project_id WHERE r.id=${roomId}`);
  return readRoomActivityPolicy(database, roomId);
}
