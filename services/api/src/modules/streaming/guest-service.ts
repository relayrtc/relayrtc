import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, type AuditActor } from "@relayrtc/auth/server";
import { guestMediaSchema } from "@relayrtc/validation";
import type { GuestResource } from "@relayrtc/types";
import type { FastifyInstance } from "fastify";
import type { RelayKitDatabase } from "@relayrtc/database";
import { id, missing, conflict, getStream, type Transaction } from "./repository.js";
import type { StreamingConfig } from "./config.js";
export const guestRowSchema = z.object({
  id: z.string(),
  broadcast_id: z.string(),
  subject: z.string(),
  name: z.string(),
  kind: z.enum(["invite", "request"]),
  state: z.enum([
    "pending",
    "accepted",
    "approved",
    "declined",
    "rejected",
    "expired",
    "cancelled",
    "joined",
    "left",
    "removed",
  ]),
  media: guestMediaSchema,
  version: z.number(),
  muted_audio: z.boolean(),
  muted_video: z.boolean(),
  participant_id: z.string().nullable(),
  actor_id: z.string(),
  created_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  last_joined_at: z.coerce.date().nullable(),
});
export type GuestRow = z.infer<typeof guestRowSchema>;
export async function getGuest(db: Transaction, key: string, run: string, lock = false) {
  const [row] = await db.execute(
    sql`SELECT * FROM stream_guest WHERE id=${key} AND broadcast_id=${run} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  if (!row) throw missing();
  return guestRowSchema.parse(row);
}
export function publicGuest(g: GuestRow, operator = false): GuestResource {
  return {
    id: g.id,
    kind: g.kind,
    state: g.state,
    version: g.version,
    name: g.name,
    media: g.media,
    mutedAudio: g.muted_audio,
    mutedVideo: g.muted_video,
    participantId: g.participant_id,
    createdAt: g.created_at.toISOString(),
    expiresAt: g.expires_at.toISOString(),
    ...(operator ? { subject: g.subject, actorId: g.actor_id } : {}),
  };
}
export async function guestEvent(db: Transaction, g: GuestRow, event: string, actor: AuditActor) {
  const stream = (
    await db.execute(
      sql`SELECT stream_id FROM stream_guest_stage WHERE broadcast_id=${g.broadcast_id}`,
    )
  )[0];
  if (!stream) return;
  const s = await getStream(db, String(stream.stream_id)),
    eventId = id("event"),
    occurredAt = new Date().toISOString();
  const [sequence] = await db.execute(
    sql`UPDATE stream_guest SET event_sequence=event_sequence+1 WHERE id=${g.id} RETURNING event_sequence`,
  );
  const body = JSON.stringify({
    id: eventId,
    type: `stream.guest.${event}`,
    projectId: s.projectId,
    environmentId: s.environmentId,
    occurredAt,
    data: {
      streamId: s.id,
      broadcastId: g.broadcast_id,
      guestId: g.id,
      state: g.state,
      version: g.version,
      sequence: Number(sequence?.event_sequence),
      actor,
    },
  });
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${s.projectId},${s.environmentId},${`stream.guest.${event}`},${occurredAt},${body}::jsonb,${body})`,
  );
  await recordAudit(db, {
    actor,
    action: `stream.guest.${event}`,
    outcome: "SUCCESS",
    organizationId: s.organizationId,
    resourceType: "stream_guest",
    resourceId: g.id,
  });
}
export async function guestCapacity(
  db: Transaction,
  run: string,
  roomId: string,
  maxGuests: number,
) {
  const [counts] = await db.execute(
    sql`SELECT count(*)::int AS n FROM stream_guest WHERE broadcast_id=${run} AND state IN ('accepted','approved','joined') AND expires_at>now()`,
  );
  const [room] = await db.execute(
    sql`SELECT max_participants,(SELECT count(*) FROM participant WHERE room_id=r.id AND left_at IS NULL)+(SELECT count(*) FROM stream_guest g JOIN stream_guest_stage st ON st.broadcast_id=g.broadcast_id WHERE st.room_id=r.id AND st.enabled AND g.state IN ('accepted','approved','joined') AND g.expires_at>now() AND NOT EXISTS(SELECT 1 FROM participant p WHERE p.id=g.participant_id AND p.left_at IS NULL)) AS occupied FROM room r WHERE id=${roomId} FOR UPDATE`,
  );
  if (Number(counts?.n) >= maxGuests || Number(room?.occupied) >= Number(room?.max_participants))
    throw conflict("GUEST_STAGE_FULL", "The stage has no unreserved guest slot.");
}
export function registerGuestMaintenance(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: StreamingConfig,
) {
  let pending: Promise<void> | undefined;
  const tick = () =>
    database.transaction(async (db) => {
      const [lock] = await db.execute(sql`SELECT pg_try_advisory_xact_lock(810041) AS ok`);
      if (!lock?.ok) return;
      await db.execute(
        sql`UPDATE stream_guest_stage st SET enabled=false,version=st.version+1 FROM broadcast_run b,streaming_stream s,project p,environment e,organization o WHERE b.id=st.broadcast_id AND s.id=st.stream_id AND p.id=s.project_id AND e.id=s.environment_id AND o.id=s.organization_id AND st.enabled AND (NOT ${config.guestsEnabled} OR b.desired_state<>'running' OR b.state IN ('stopping','stopped','failed') OR NOT EXISTS(SELECT 1 FROM room r WHERE r.id=st.room_id AND r.status IN ('created','active')) OR s.source->>'kind'<>'room' OR s.source->>'roomId' IS DISTINCT FROM st.room_id OR s.status<>'active' OR p.status<>'active' OR e.status<>'active' OR o.status<>'active')`,
      );
      const rows = await db.execute(
        sql`SELECT g.*,st.enabled,p.left_at AS rtc_left,p.joined_at AS rtc_joined FROM stream_guest g JOIN stream_guest_stage st ON st.broadcast_id=g.broadcast_id LEFT JOIN participant p ON p.id=g.participant_id WHERE g.state IN ('pending','accepted','approved','joined') AND (NOT st.enabled OR g.expires_at<=now() OR p.left_at IS NOT NULL OR (p.joined_at IS NOT NULL AND g.state<>'joined')) ORDER BY g.id FOR UPDATE OF g SKIP LOCKED LIMIT 200`,
      );
      const actor: AuditActor = { type: "SYSTEM", name: "Guest lifecycle" };
      for (const row of rows) {
        const g = guestRowSchema.parse(row);
        let next: GuestRow["state"] | null = null,
          event = "";
        if (!row.enabled || g.expires_at.getTime() <= Date.now()) {
          next = "expired";
          event = g.kind === "invite" && g.state === "pending" ? "invite_expired" : "grant_revoked";
        } else if (row.rtc_left) {
          next = "left";
          event = "left";
        } else if (row.rtc_joined && g.state !== "joined") {
          next = "joined";
          event = "joined";
        }
        if (next) {
          await db.execute(
            sql`UPDATE stream_guest SET state=${next},version=version+${next === "joined" ? 0 : 1},last_joined_at=CASE WHEN ${next === "joined"} THEN now() ELSE last_joined_at END WHERE id=${g.id}`,
          );
          await guestEvent(db, await getGuest(db, g.id, g.broadcast_id), event, actor);
        }
      }
      await db.execute(
        sql`DELETE FROM stream_audience WHERE id IN(SELECT id FROM stream_audience WHERE expires_at<now()-interval '1 day' LIMIT 1000)`,
      );
      await db.execute(
        sql`DELETE FROM stream_guest_grant WHERE token_id IN(SELECT token_id FROM stream_guest_grant WHERE expires_at<now()-interval '1 day' LIMIT 1000)`,
      );
    });
  const timer = setInterval(() => {
    pending ??= tick()
      .catch((err: unknown) => {
        app.log.error({ err }, "Guest lifecycle maintenance failed");
      })
      .finally(() => {
        pending = undefined;
      });
  }, 2000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
