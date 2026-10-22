import type { RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";
import { ApiError } from "../../http/errors/api-error.js";
import type { RenewalSession } from "./participant-token-renewal.service.js";

export function createActiveRenewalSession(database: RelayKitDatabase) {
  return async <T>(scope: RenewalSession, action: () => Promise<T>): Promise<T> =>
    database.transaction(async (transaction) => {
      await transaction.execute(sql`set local statement_timeout = '5s'`);
      await transaction.execute(sql`set local lock_timeout = '2s'`);
      const [active] = await transaction.execute(sql`
      select s.id from participant_session s
      join participant p on p.id = s.participant_id join room r on r.id = p.room_id
      join project pr on pr.id = r.project_id
      join environment e on e.id = r.environment_id and e.project_id = pr.id
      join organization o on o.id = pr.organization_id
      where s.id = ${scope.sessionId} and p.id = ${scope.participantId} and r.id = ${scope.roomId}
        and r.project_id = ${scope.projectId} and r.environment_id = ${scope.environmentId}
        and pr.status = 'active' and e.status = 'active' and o.status = 'active'
        and r.status = 'active' and r.ended_at is null and p.left_at is null and p.removed_at is null
        and s.connection_state in ('connected', 'reconnecting')
        and (s.signaling_instance_id is null or exists (
          select 1 from signaling_node_lease l where l.node_id = s.signaling_node_id
            and l.instance_id = s.signaling_instance_id and l.expires_at > now()
        )) for share of s, p, r, pr, e, o
    `);
      if (!active)
        throw new ApiError(
          403,
          "PARTICIPANT_SESSION_NOT_ACTIVE",
          "The participant session or its owning scope is no longer active",
        );
      return action();
    });
}
