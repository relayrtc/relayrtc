import { randomUUID } from "node:crypto";

import { ApiError } from "../../http/errors/api-error.js";
import type { RoomRepository, RoomScope } from "../rooms/room.repository.js";
import type { CreateParticipantTokenBody } from "./participant-token.schema.js";
import type { ParticipantTokenClaims, ParticipantTokenSigner } from "./participant-token.signer.js";

interface ParticipantTokenResponse {
  expiresAt: string;
  participantId: string;
  token: string;
  tokenId: string;
}

interface ParticipantTokenServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  isProjectActive: (scope: RoomScope) => Promise<boolean>;
  roomRepository: RoomRepository;
  signer: ParticipantTokenSigner;
  requireAdmission?: (roomId: string) => Promise<void>;
}

export const createParticipantTokenService = (options: ParticipantTokenServiceOptions) => ({
  async create(
    scope: RoomScope,
    roomId: string,
    input: CreateParticipantTokenBody,
  ): Promise<ParticipantTokenResponse> {
    const room = await options.roomRepository.find(scope, roomId);
    if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "The room does not exist");
    if (room.status === "ending" || room.status === "ended" || room.status === "failed") {
      throw new ApiError(409, "ROOM_NOT_JOINABLE", "The room is not accepting participants");
    }

    if (!(await options.isProjectActive(scope))) {
      throw new ApiError(409, "PROJECT_NOT_ACTIVE", "The project is not accepting participants");
    }
    await options.requireAdmission?.(roomId);

    const createId = options.createId ?? (() => randomUUID().replaceAll("-", ""));
    const issuedAt = options.clock?.() ?? new Date();
    const expiresAt = new Date(issuedAt.getTime() + input.ttlSeconds * 1_000);
    const participantId = `participant_${createId()}`;
    const tokenId = `ptok_${createId()}`;
    const claims: ParticipantTokenClaims = {
      environmentId: scope.environmentId,
      expiresAt: expiresAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
      metadata: input.metadata,
      participantId,
      participantName: input.participantName,
      permissions: input.permissions,
      projectId: scope.projectId,
      roomId: room.id,
      tokenId,
    };

    return {
      expiresAt: claims.expiresAt,
      participantId,
      token: await options.signer.sign(claims),
      tokenId,
    };
  },
});
