import type { ParticipantAccess, RoomCapabilities, UpdateParticipantAccess } from "@relayrtc/types";

export interface RoomAccessControl {
  readonly current: RoomCapabilities | null;
  get(participantId: string): Promise<ParticipantAccess>;
  update(participantId: string, input: UpdateParticipantAccess): Promise<ParticipantAccess>;
}

export type {
  ParticipantAccess,
  RoomCapabilities,
  UpdateParticipantAccess,
  RoomRole,
  RoomParticipantPermission,
} from "@relayrtc/types";
