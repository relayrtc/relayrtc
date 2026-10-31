export interface RoomLifecycle {
  readonly roomId: string;
  readonly version: number;
  readonly locked: boolean;
  readonly endsAt: string | null;
  readonly warning: boolean;
  readonly serverTime: string;
}

export interface UpdateRoomLifecycle {
  readonly version: number;
  readonly locked: boolean;
  readonly endsAt: string | null;
}

export interface RoomInvitation {
  readonly id: string;
  readonly roomId: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly maxUses: number;
  readonly uses: number;
  readonly identity: string | null;
  readonly permissions: readonly string[];
  readonly createdAt: string;
}

export interface CreateRoomInvitation {
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly identity: string | null;
  readonly permissions: readonly string[];
}

export interface RedeemRoomInvitation {
  readonly secret: string;
  readonly redemptionId: string;
  readonly identity: string;
  readonly participantName: string;
}
