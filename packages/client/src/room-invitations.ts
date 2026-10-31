import type { CreateRoomInvitation, RedeemRoomInvitation, RoomInvitation } from "@relayrtc/types";

export interface RoomInvitationBackend {
  create(
    input: CreateRoomInvitation,
    signal: AbortSignal,
  ): Promise<{ invitation: RoomInvitation; secret: string }>;
  list(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    nodes: readonly RoomInvitation[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>;
  revoke(invitationId: string, signal: AbortSignal): Promise<RoomInvitation>;
  redeem(
    input: Omit<RedeemRoomInvitation, "identity">,
    signal: AbortSignal,
  ): Promise<{ token: string; participantId: string; tokenId: string; expiresAt: string }>;
}
