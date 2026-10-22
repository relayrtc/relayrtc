import { randomUUID } from "node:crypto";
import { ApiError } from "../../http/errors/api-error.js";
import type { RoomScope } from "../rooms/room.repository.js";
import type { RenewParticipantTokenBody } from "./participant-token.schema.js";
import type { ParticipantTokenSigner, ParticipantTokenClaims } from "./participant-token.signer.js";
import type { ParticipantTokenVerifier } from "./participant-token.verifier.js";

export interface RenewalSession extends RoomScope {
  roomId: string;
  participantId: string;
  sessionId: string;
}

export function createParticipantTokenRenewalService(options: {
  signer: ParticipantTokenSigner;
  verifier: ParticipantTokenVerifier;
  // Runs eligibility checks and signing under the same database locks.
  withActiveSession: <T>(session: RenewalSession, action: () => Promise<T>) => Promise<T>;
  clock?: () => Date;
  createId?: () => string;
}) {
  return {
    async renew(scope: RoomScope, roomId: string, input: RenewParticipantTokenBody) {
      const now = options.clock?.() ?? new Date();
      const current = await options.verifier.verify(input.participantToken, now);
      if (
        current.projectId !== scope.projectId ||
        current.environmentId !== scope.environmentId ||
        current.roomId !== roomId
      ) {
        throw new ApiError(
          403,
          "TOKEN_SCOPE_MISMATCH",
          "The participant token does not belong to this room and API key scope",
        );
      }
      if (current.participantId.startsWith("guestp_")) {
        throw new ApiError(
          403,
          "GUEST_TOKEN_RENEWAL_REQUIRED",
          "Streaming guests must renew through the guest join-grant API",
        );
      }
      return options.withActiveSession(
        { ...scope, roomId, participantId: current.participantId, sessionId: input.sessionId },
        async () => {
          const issuedAt = options.clock?.() ?? new Date();
          if (
            Math.floor(issuedAt.getTime() / 1000) >=
            Math.floor(Date.parse(current.expiresAt) / 1000)
          ) {
            throw new ApiError(
              401,
              "INVALID_PARTICIPANT_TOKEN",
              "The participant token expired before renewal completed",
            );
          }
          const expiresAt = new Date(issuedAt.getTime() + input.ttlSeconds * 1000).toISOString();
          if (
            Math.floor(Date.parse(expiresAt) / 1000) <=
            Math.floor(Date.parse(current.expiresAt) / 1000)
          ) {
            throw new ApiError(
              409,
              "TOKEN_EXPIRATION_NOT_EXTENDED",
              "Renew closer to expiry or request a longer lifetime",
            );
          }
          const tokenId = `ptok_${options.createId?.() ?? randomUUID().replaceAll("-", "")}`;
          // Only verified original grants are copied; callers cannot change permissions/identity.
          const claims: ParticipantTokenClaims = {
            environmentId: current.environmentId,
            projectId: current.projectId,
            roomId: current.roomId,
            participantId: current.participantId,
            participantName: current.participantName,
            metadata: current.metadata,
            permissions: current.permissions,
            issuedAt: issuedAt.toISOString(),
            expiresAt,
            tokenId,
          };
          return {
            token: await options.signer.sign(claims),
            tokenId,
            participantId: claims.participantId,
            expiresAt,
          };
        },
      );
    },
  };
}
