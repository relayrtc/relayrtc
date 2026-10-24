import type { RelayKitDatabase } from "@relayrtc/database";
import { schema } from "@relayrtc/database";
import type { Metadata, RoomStatus } from "@relayrtc/types";
import { and, desc, eq, ilike, inArray, lt, ne, or } from "drizzle-orm";

export interface RoomScope {
  environmentId: string;
  projectId: string;
}

export interface RoomRecord extends RoomScope {
  createdAt: Date;
  endedAt: Date | null;
  id: string;
  maxParticipants: number;
  metadata: Metadata;
  name: string;
  startedAt: Date | null;
  status: RoomStatus;
}

export interface RoomCursor {
  createdAt: Date;
  id: string;
}

export interface CreateRoomRecord extends RoomScope {
  id: string;
  maxParticipants: number;
  metadata: Metadata;
  name: string;
}

export interface ListRoomRecords extends RoomScope {
  cursor?: RoomCursor;
  limit: number;
  status?: RoomStatus;
  search?: string;
  joinable?: boolean;
}

export interface RoomRepository {
  create(input: CreateRoomRecord): Promise<RoomRecord>;
  end(scope: RoomScope, roomId: string, endedAt: Date): Promise<RoomRecord | null>;
  find(scope: RoomScope, roomId: string): Promise<RoomRecord | null>;
  list(input: ListRoomRecords): Promise<readonly RoomRecord[]>;
}

type DatabaseRoom = typeof schema.room.$inferSelect;

const toRecord = (room: DatabaseRoom): RoomRecord => ({
  ...room,
  metadata: room.metadata as Metadata,
  status: room.status as RoomStatus,
});

export const createRoomRepository = (database: RelayKitDatabase): RoomRepository => ({
  async create(input) {
    const [created] = await database.insert(schema.room).values(input).returning();
    if (!created) throw new Error("Room insert did not return a record");
    return toRecord(created);
  },

  async end(scope, roomId, endedAt) {
    const [ended] = await database
      .update(schema.room)
      .set({ endedAt, status: "ended" })
      .where(
        and(
          eq(schema.room.id, roomId),
          eq(schema.room.projectId, scope.projectId),
          eq(schema.room.environmentId, scope.environmentId),
          ne(schema.room.status, "ended"),
        ),
      )
      .returning();

    if (ended) return toRecord(ended);
    return this.find(scope, roomId);
  },

  async find(scope, roomId) {
    const [found] = await database
      .select()
      .from(schema.room)
      .where(
        and(
          eq(schema.room.id, roomId),
          eq(schema.room.projectId, scope.projectId),
          eq(schema.room.environmentId, scope.environmentId),
        ),
      )
      .limit(1);

    return found ? toRecord(found) : null;
  },

  async list(input) {
    const conditions = [
      eq(schema.room.projectId, input.projectId),
      eq(schema.room.environmentId, input.environmentId),
    ];

    if (input.status) conditions.push(eq(schema.room.status, input.status));
    if (input.joinable) conditions.push(inArray(schema.room.status, ["created", "active"]));
    if (input.search) {
      const pattern = `%${input.search.replace(/[\\%_]/gu, "\\$&")}%`;
      const match = or(ilike(schema.room.name, pattern), ilike(schema.room.id, pattern));
      if (match) conditions.push(match);
    }
    if (input.cursor) {
      const cursorCondition = or(
        lt(schema.room.createdAt, input.cursor.createdAt),
        and(
          eq(schema.room.createdAt, input.cursor.createdAt),
          lt(schema.room.id, input.cursor.id),
        ),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }

    const rooms = await database
      .select()
      .from(schema.room)
      .where(and(...conditions))
      .orderBy(desc(schema.room.createdAt), desc(schema.room.id))
      .limit(input.limit + 1);

    return rooms.map(toRecord);
  },
});
