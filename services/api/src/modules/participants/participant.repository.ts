import type { RelayKitDatabase } from "@relayrtc/database";
import { schema } from "@relayrtc/database";
import type { Metadata } from "@relayrtc/types";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

export interface ParticipantRecord {
  externalId: string | null;
  id: string;
  joinedAt: Date;
  leftAt: Date | null;
  removedAt?: Date | null;
  metadata: Metadata;
  name: string;
  role: string;
  roomId: string;
}

export interface ParticipantCursor {
  id: string;
  joinedAt: Date;
}

export interface ListParticipantRecords {
  cursor?: ParticipantCursor;
  limit: number;
  roomId: string;
  status?: "active" | "left";
}

export interface ParticipantRepository {
  find(roomId: string, participantId: string): Promise<ParticipantRecord | null>;
  list(input: ListParticipantRecords): Promise<readonly ParticipantRecord[]>;
  remove(roomId: string, participantId: string, leftAt: Date): Promise<ParticipantRecord | null>;
}

type DatabaseParticipant = typeof schema.participant.$inferSelect;

const toRecord = (participant: DatabaseParticipant): ParticipantRecord => ({
  id: participant.id,
  roomId: participant.roomId,
  externalId: participant.externalId,
  name: participant.name,
  role: participant.role,
  joinedAt: participant.joinedAt,
  leftAt: participant.leftAt,
  removedAt: participant.removedAt,
  metadata: participant.metadata as Metadata,
});

export const createParticipantRepository = (database: RelayKitDatabase): ParticipantRepository => {
  const find = async (roomId: string, participantId: string): Promise<ParticipantRecord | null> => {
    const [found] = await database
      .select()
      .from(schema.participant)
      .where(and(eq(schema.participant.id, participantId), eq(schema.participant.roomId, roomId)))
      .limit(1);

    return found ? toRecord(found) : null;
  };

  return {
    find,

    async list(input) {
      const conditions = [eq(schema.participant.roomId, input.roomId)];
      if (input.status === "active") conditions.push(isNull(schema.participant.leftAt));
      if (input.status === "left") conditions.push(isNotNull(schema.participant.leftAt));
      if (input.cursor) {
        const cursorCondition = or(
          lt(schema.participant.joinedAt, input.cursor.joinedAt),
          and(
            eq(schema.participant.joinedAt, input.cursor.joinedAt),
            lt(schema.participant.id, input.cursor.id),
          ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }

      const participants = await database
        .select()
        .from(schema.participant)
        .where(and(...conditions))
        .orderBy(desc(schema.participant.joinedAt), desc(schema.participant.id))
        .limit(input.limit + 1);

      return participants.map(toRecord);
    },

    async remove(roomId, participantId, leftAt) {
      const [removed] = await database
        .update(schema.participant)
        .set({
          leftAt: sql`coalesce(${schema.participant.leftAt}, ${leftAt.toISOString()}::timestamptz)`,
          removedAt: leftAt,
        })
        .where(
          and(
            eq(schema.participant.id, participantId),
            eq(schema.participant.roomId, roomId),
            isNull(schema.participant.removedAt),
          ),
        )
        .returning();

      return removed ? toRecord(removed) : find(roomId, participantId);
    },
  };
};
