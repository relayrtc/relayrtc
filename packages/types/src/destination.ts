export const destinationEventTypes = [
  "destination.created",
  "destination.connected",
  "destination.disconnected",
  "destination.retrying",
  "destination.failed",
] as const;
export type DestinationProfile = "remux" | "720p" | "1080p";
export interface StreamDestination {
  id: string;
  streamId: string;
  name: string;
  host: string;
  protocol: "rtmp" | "rtmps";
  port: number;
  profile: DestinationProfile;
  enabled: boolean;
  version: number;
  credentialVersion: number;
  secretConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface DestinationSnapshot {
  id: string;
  version: number;
  credentialVersion: number;
  name: string;
  profile: DestinationProfile;
}
