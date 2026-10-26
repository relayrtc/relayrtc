export const streamSourceKinds = ["room", "whip", "rtmp"] as const;
export const streamSessionStates = [
  "starting",
  "live",
  "reconnecting",
  "stopping",
  "ended",
  "failed",
] as const;
export const streamEventTypes = [
  "stream.created",
  "stream.starting",
  "stream.live",
  "stream.reconnecting",
  "stream.ended",
  "stream.failed",
] as const;
export type StreamSource =
  | { kind: "room"; roomId: string; videoTrackIds: string[]; audioTrackIds: string[] }
  | { kind: "whip" | "rtmp" };
export interface StreamPlaybackReadiness {
  status: "waiting" | "starting" | "ready" | "reconnecting" | "degraded" | "failed" | "ended";
  publisherConnected: boolean;
  sourceProducing: boolean;
  outputStarting: boolean;
  viewerReady: boolean;
  code: string | null;
  checkedAt: string;
}
export interface StreamProfile {
  audioOnly: boolean;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  layout: "single" | "grid";
}
export interface StreamConfiguration {
  name: string;
  source: StreamSource;
  profile: StreamProfile;
  maxDurationSeconds: number;
  retentionSeconds: number;
}
export interface StreamResource extends StreamConfiguration {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  status: "active" | "deleting" | "deleted";
  version: number;
  playbackEpoch: number;
  createdAt: string;
  updatedAt: string;
}
export interface StreamSession {
  id: string;
  streamId: string;
  state: (typeof streamSessionStates)[number];
  desiredState: "running" | "stopped";
  generation: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  lastHeartbeatAt: string | null;
  endedAt: string | null;
  sourceInfo: {
    tracks: {
      kind: "audio" | "video";
      codec: string;
      trackId?: string;
      width?: number;
      height?: number;
    }[];
  };
  ingressBitrate: number;
  programBitrate: number;
}
export interface StreamingOperation {
  id: string;
  streamId: string;
  sessionId: string | null;
  kind:
    "start" | "stop" | "delete" | "broadcast.start" | "broadcast.stop" | "broadcast.output.retry";
  broadcastId?: string | null;
  outputId?: string | null;
  status: "pending" | "completed" | "failed";
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface StreamingUsage {
  streamId: string;
  sourceSeconds: number;
  ingressBytes: number;
  programBytes: number;
  coverage: "observed" | "partial";
  samples: number;
}
