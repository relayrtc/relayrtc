import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { RoomScope } from "../rooms/room.repository.js";

const s = schema.participantSession, p = schema.participant, r = schema.room;
const live = sql<boolean>`${s.connectionState} = 'connected' AND ${p.leftAt} IS NULL AND ${p.removedAt} IS NULL AND ${r.status} IN ('created', 'active')`;
const disconnected = sql<boolean>`(${s.connectionState} IN ('disconnected', 'failed') OR ${p.leftAt} IS NOT NULL OR ${p.removedAt} IS NOT NULL OR ${r.status} NOT IN ('created', 'active'))`;
const scopeFilter = (scope: RoomScope) => and(eq(r.projectId, scope.projectId), eq(r.environmentId, scope.environmentId));
const statColumns = {
  totalParticipants: sql<number>`count(distinct ${p.id})::int`,
  connectedParticipants: sql<number>`count(distinct ${p.id}) filter (where ${live})::int`,
  totalSessions: sql<number>`count(${s.id})::int`,
  connectedSessions: sql<number>`count(${s.id}) filter (where ${live})::int`,
  disconnectedSessions: sql<number>`count(${s.id}) filter (where ${disconnected})::int`,
  reconnectingSessions: sql<number>`count(${s.id}) filter (where ${s.connectionState} = 'reconnecting' AND ${p.leftAt} IS NULL AND ${p.removedAt} IS NULL AND ${r.status} IN ('created', 'active'))::int`,
  messagesIn: sql<number>`coalesce(sum(${s.messagesIn}), 0)::double precision`,
  messagesOut: sql<number>`coalesce(sum(${s.messagesOut}), 0)::double precision`,
};
export const emptyRoomStats = { totalParticipants: 0, connectedParticipants: 0, totalSessions: 0, connectedSessions: 0, disconnectedSessions: 0, reconnectingSessions: 0, messagesIn: 0, messagesOut: 0 };

export async function readRoomStats(database: RelayKitDatabase, scope: RoomScope, roomIds: string[]) {
  if (!roomIds.length) return new Map<string, typeof emptyRoomStats>();
  const rows = await database.select({ roomId: r.id, ...statColumns }).from(r)
    .leftJoin(p, eq(p.roomId, r.id)).leftJoin(s, eq(s.participantId, p.id))
    .where(and(scopeFilter(scope), inArray(r.id, roomIds))).groupBy(r.id);
  return new Map(rows.map(({ roomId, ...stats }) => [roomId, stats]));
}

export async function readRealtimeSummary(database: RelayKitDatabase, scope: RoomScope) {
  const [rooms, sessions] = await Promise.all([
    database.select({ totalRooms: sql<number>`count(*)::int`, activeRooms: sql<number>`count(*) filter (where ${r.status} = 'active')::int`, createdRooms: sql<number>`count(*) filter (where ${r.status} = 'created')::int` }).from(r).where(scopeFilter(scope)),
    database.select(statColumns).from(r).leftJoin(p, eq(p.roomId, r.id)).leftJoin(s, eq(s.participantId, p.id)).where(scopeFilter(scope)),
  ]);
  return { ...emptyRoomStats, ...sessions[0], totalRooms: rooms[0]?.totalRooms ?? 0, activeRooms: rooms[0]?.activeRooms ?? 0, createdRooms: rooms[0]?.createdRooms ?? 0, observedAt: new Date().toISOString() };
}

export const roomSessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  search: z.string().trim().max(120).default(""),
  status: z.enum(["all", "connected", "disconnected"]).default("all"),
}).strict();

const sessionColumns = {
  id: s.id, participantId: p.id, name: p.name, role: p.role, externalId: p.externalId,
  leftAt: p.leftAt, removedAt: p.removedAt, state: s.connectionState, transport: s.transportType,
  joinedAt: s.joinedAt, disconnectedAt: s.disconnectedAt, reconnectedAt: s.reconnectedAt,
  messagesIn: s.messagesIn, messagesOut: s.messagesOut, live,
  // Sum actual connection intervals so reconnecting/offline time is excluded.
  connectionSeconds: sql<number>`coalesce((select sum(greatest(0, extract(epoch from
    (least(coalesce(i.ended_at, now()), coalesce(${p.leftAt}, now()), coalesce(${r.endedAt}, now())) - i.started_at))))
    from participant_connection_interval i where i.session_id = ${s.id}), 0)::double precision`,
};

export async function readRoomSessions(database: RelayKitDatabase, scope: RoomScope, roomId: string, query: z.infer<typeof roomSessionsQuery>) {
  const pattern = `%${query.search.replace(/[\\%_]/gu, "\\$&")}%`;
  const filter = and(scopeFilter(scope), eq(r.id, roomId),
    query.search ? or(ilike(p.name, pattern), ilike(p.id, pattern), ilike(s.id, pattern)) : undefined,
    query.status === "connected" ? live : query.status === "disconnected" ? disconnected : undefined);
  const [sessions, counts] = await Promise.all([
    database.select(sessionColumns).from(s).innerJoin(p, eq(s.participantId, p.id)).innerJoin(r, eq(p.roomId, r.id))
      .where(filter).orderBy(desc(s.joinedAt), desc(s.id)).limit(query.limit).offset(query.offset),
    database.select({ total: sql<number>`count(*)::int` }).from(s).innerJoin(p, eq(s.participantId, p.id)).innerJoin(r, eq(p.roomId, r.id)).where(filter),
  ]);
  return { sessions, pagination: { limit: query.limit, offset: query.offset, total: counts[0]?.total ?? 0 }, observedAt: new Date().toISOString() };
}

export async function readRoomSession(database: RelayKitDatabase, scope: RoomScope, roomId: string, sessionId: string) {
  const [session] = await database.select({ ...sessionColumns, country: s.country, countryCode: s.countryCode, metadata: p.metadata })
    .from(s).innerJoin(p, eq(s.participantId, p.id)).innerJoin(r, eq(p.roomId, r.id))
    .where(and(scopeFilter(scope), eq(r.id, roomId), eq(s.id, sessionId)));
  if (!session) return null;
  return { session, observedAt: new Date().toISOString() };
}
