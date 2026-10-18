import type { RecordingPolicy } from "./recording.js";
import type { StreamProfile, StreamSource } from "./streaming.js";
import type { DestinationSnapshot } from "./destination.js";

export const broadcastEventTypes = [
  "broadcast.created",
  "broadcast.starting",
  "broadcast.live",
  "broadcast.reconnecting",
  "broadcast.output_degraded",
  "broadcast.stopped",
  "broadcast.failed",
] as const;
export type BroadcastState =
  | "created"
  | "waiting_for_source"
  | "starting"
  | "live"
  | "reconnecting"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";
export interface BroadcastSnapshot {
  streamVersion: number;
  source: StreamSource;
  profile: StreamProfile;
  outputs: { kind: "hls" }[];
  destinations: DestinationSnapshot[];
  recording: false | RecordingPolicy;
}
export interface BroadcastResource {
  id: string;
  streamId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  name: string;
  state: BroadcastState;
  desiredState: "idle" | "running" | "stopped";
  version: number;
  snapshot: BroadcastSnapshot;
  sourceSessionId: string | null;
  sourceGeneration: number | null;
  waitTimeoutSeconds: number;
  maxDurationSeconds: number;
  lastError: string | null;
  correlationId: string | null;
  createdAt: string;
  startRequestedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
}
export interface BroadcastOutput {
  id: string;
  broadcastId: string;
  kind: "hls" | "rtmp";
  destinationId: string | null;
  destinationName: string | null;
  outputSeconds: number;
  bytes: number;
  bitrate: number;
  droppedFrames: number;
  transcodeSeconds: number;
  state: "queued" | "running" | "retry" | "stopping" | "completed" | "failed" | "cancelled";
  attempts: number;
  fence: number;
  lastError: string | null;
  lastHeartbeatAt: string | null;
  sourceSessionId: string | null;
  sourceGeneration: number | null;
}
export interface BroadcastUsage {
  runSeconds: number;
  outputSeconds: number;
  reservationSeconds: number;
  coverage: "observed" | "partial";
  samples: number;
  bytes: number;
  transcodeSeconds: number;
}
