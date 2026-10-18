export interface GuestMedia {
  audio: boolean;
  video: boolean;
  screen: boolean;
}
export type GuestRole = "host" | "cohost" | "moderator" | "guest" | "viewer";
export type GuestDelegation = "invite" | "approve" | "moderate";
export interface GuestResource {
  id: string;
  kind: "invite" | "request";
  state:
    | "pending"
    | "accepted"
    | "declined"
    | "approved"
    | "rejected"
    | "cancelled"
    | "expired"
    | "joined"
    | "left"
    | "removed";
  version: number;
  name: string;
  media: GuestMedia;
  mutedAudio: boolean;
  mutedVideo: boolean;
  participantId: string | null;
  createdAt: string;
  expiresAt: string;
  subject?: string | undefined;
  actorId?: string | undefined;
}
export interface GuestStage {
  enabled: boolean;
  version: number;
  maxGuests: number;
  occupied: number;
  layout: "single" | "grid" | "pip";
  roomId: string;
}
export interface GuestRoster {
  data: GuestResource[];
  nextCursor: string | null;
  stage: GuestStage;
}
export interface GuestJoinGrant {
  token: string;
  participantId: string;
  roomId: string;
  expiresAt: string;
  version: number;
  media: GuestMedia;
  signalingUrl: string;
}
