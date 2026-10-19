import type { RelayKitDatabase } from "@relayrtc/database";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { ApiError } from "../../http/errors/api-error.js";
import type { TurnCredentialIssuer, TurnCredentialScope } from "./turn-credential.service.js";

export function createRetainedTurnCredentialIssuer(
  database: RelayKitDatabase,
  issuer: TurnCredentialIssuer,
  managedRealm?: string,
): TurnCredentialIssuer {
  return {
    async issue(scope: TurnCredentialScope) {
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`set local statement_timeout = '5s'`);
        await transaction.execute(sql`set local lock_timeout = '2s'`);
        const [project] = await transaction.execute(sql`
          select p.organization_id from project p join environment e on e.project_id = p.id
          join organization o on o.id = p.organization_id
          where p.id = ${scope.projectId} and e.id = ${scope.environmentId}
            and p.status = 'active' and e.status = 'active' and o.status = 'active' for share of p, e, o
        `);
        if (!project) throw new ApiError(403, "FORBIDDEN", "The TURN credential scope is inactive");
        let participantId: string | null = null;
        if (scope.roomId || scope.sessionId) {
          if (!scope.roomId || !scope.sessionId)
            throw new ApiError(400, "INVALID_REQUEST", "Provide roomId and sessionId together");
          const [session] = await transaction.execute(sql`
            select p.id from participant_session s join participant p on p.id = s.participant_id
            join room r on r.id = p.room_id
            where s.id = ${scope.sessionId} and r.id = ${scope.roomId}
              and r.project_id = ${scope.projectId} and r.environment_id = ${scope.environmentId}
              and r.status = 'active' and p.left_at is null and p.removed_at is null
              and r.ended_at is null and s.connection_state in ('connected', 'reconnecting')
              and (s.signaling_instance_id is null or exists (
                select 1 from signaling_node_lease l where l.node_id = s.signaling_node_id
                  and l.instance_id = s.signaling_instance_id and l.expires_at > now()
              )) for share of s, p, r
          `);
          if (!session)
            throw new ApiError(
              404,
              "NOT_FOUND",
              "The participant session is unavailable in this scope",
            );
          participantId = String(session.id);
        }
        const credentials = await issuer.issue(scope);
        const password = credentials.iceServers.find(
          (server) => server.username === credentials.username,
        )?.credential;
        if (managedRealm && !password)
          throw new Error("Managed TURN credentials require a password");
        const authenticationKey = managedRealm
          ? createHash("md5")
              .update(`${credentials.username}:${managedRealm}:${password}`)
              .digest("hex")
          : null;
        await transaction.execute(sql`
          insert into turn_credential (username, organization_id, project_id, environment_id, room_id, session_id, participant_id, issued_at, expires_at, realm, authentication_key)
          values (${credentials.username}, ${String(project.organization_id)}, ${scope.projectId}, ${scope.environmentId},
            ${scope.roomId ?? null}, ${scope.sessionId ?? null}, ${participantId}, now(), ${credentials.expiresAt}::timestamptz,
            ${managedRealm ?? null}, ${authenticationKey})
        `);
        return credentials;
      });
    },
  };
}
