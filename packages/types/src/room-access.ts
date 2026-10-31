export const roomRoles = ["host", "moderator", "participant"] as const;
export type RoomRole = (typeof roomRoles)[number];
export const roomParticipantPermissions = [
  "room:join",
  "audio:publish",
  "video:publish",
  "screen:publish",
  "messages:send",
  "metadata:update",
] as const;
export type RoomParticipantPermission = (typeof roomParticipantPermissions)[number];

export interface ParticipantAccess {
  readonly roomId: string;
  readonly participantId: string;
  readonly role: RoomRole;
  readonly version: number;
  readonly allowedPermissions: readonly RoomParticipantPermission[] | null;
}

export interface UpdateParticipantAccess {
  readonly version: number;
  readonly role: RoomRole;
  readonly allowedPermissions: readonly RoomParticipantPermission[] | null;
}

export interface RoomCapabilities {
  readonly roomId: string;
  readonly participantId: string;
  readonly role: RoomRole;
  readonly version: number;
  readonly permissions: readonly RoomParticipantPermission[];
  readonly canManageRoles: boolean;
  readonly canManagePermissions: boolean;
}

export interface RoomAuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly correlationId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}
