import type { RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";

export interface SpeakerFrame {
  readonly observedAt: Date;
  readonly speakers: readonly { sessionId: string; level: number }[];
  readonly dominantSessionId: string | null;
}
export interface SpeakerStore {
  publish(roomId: string, frame: SpeakerFrame): Promise<void>;
  clear(roomId: string): Promise<void>;
}

export function createSpeakerStore(database: RelayKitDatabase, nodeId: string): SpeakerStore {
  return {
    async publish(roomId, frame) {
      await database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout='2s'`);
        await tx.execute(sql`INSERT INTO room_speaker_snapshot(room_id,node_id,observed_at,speakers,dominant_session_id)
          SELECT ${roomId},${nodeId},${frame.observedAt.toISOString()}::timestamptz,coalesce((SELECT jsonb_agg(item)
            FROM jsonb_array_elements(${JSON.stringify(frame.speakers)}::jsonb) item
            JOIN participant_session s ON s.id=item->>'sessionId' JOIN participant p ON p.id=s.participant_id
            JOIN participant_activity a ON a.participant_id=p.id
            WHERE p.room_id=${roomId} AND policy.speakers_enabled AND a.share_speaking AND p.left_at IS NULL AND p.removed_at IS NULL AND s.connection_state='connected'),'[]'::jsonb),
            CASE WHEN policy.speakers_enabled AND EXISTS(SELECT 1 FROM participant_session s JOIN participant_activity a ON a.participant_id=s.participant_id
              WHERE s.id=${frame.dominantSessionId} AND a.share_speaking) THEN ${frame.dominantSessionId} ELSE NULL END
          FROM media_room_runtime m JOIN room_activity_policy policy ON policy.room_id=m.room_id
          JOIN room r ON r.id=m.room_id WHERE m.room_id=${roomId} AND m.node_id=${nodeId} AND r.status='active'
          ON CONFLICT(room_id) DO UPDATE SET node_id=EXCLUDED.node_id,observed_at=EXCLUDED.observed_at,
            speakers=EXCLUDED.speakers,dominant_session_id=EXCLUDED.dominant_session_id
          WHERE room_speaker_snapshot.observed_at<EXCLUDED.observed_at`);
      });
    },
    async clear(roomId) {
      await database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout='2s'`);
        await tx.execute(
          sql`DELETE FROM room_speaker_snapshot WHERE room_id=${roomId} AND node_id=${nodeId}`,
        );
      });
    },
  };
}
