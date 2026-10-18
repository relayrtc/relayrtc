export const recordingEventTypes = [
  "recording.started",
  "recording.segment_committed",
  "recording.finalizing",
  "recording.ready",
  "recording.failed",
  "recording.deleted",
] as const;
export interface RecordingPolicy {
  mode: "manual" | "automatic";
  maxDurationSeconds: number;
  retentionSeconds: number;
  region: string;
  allowPartial: boolean;
  exportMp4: boolean;
  segmentEvents: boolean;
  consentAcknowledged: boolean;
}
export type RecordingState =
  "queued" | "recording" | "finalizing" | "ready" | "failed" | "deleting" | "deleted";
export interface RecordingResource {
  id: string;
  streamId: string;
  broadcastId: string;
  assetId: string;
  projectId: string;
  environmentId: string;
  state: RecordingState;
  policy: RecordingPolicy;
  partial: boolean;
  lastError: string | null;
  durationSeconds: number;
  storedBytes: number;
  storageByteSeconds: number;
  processingSeconds: number;
  segmentCount: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  expiresAt: string | null;
}
export interface MediaAsset {
  id: string;
  recordingId: string;
  streamId: string;
  broadcastId: string;
  state: RecordingState;
  partial: boolean;
  durationSeconds: number;
  region: string;
  formats: ("hls" | "mp4")[];
  hasThumbnail: boolean;
  codecs: string[];
  sizeBytes: number;
  expiresAt: string | null;
}
export interface AssetAccessGrant {
  assetId: string;
  action: "playback" | "download";
  url: string;
  expiresAt: string;
}
export interface RecordingPlayback {
  mode: "vod";
  recordingId: string;
  assetId: string;
  streamId: string;
  sourceSessionId: string;
  generation: number;
  state: "ready" | "starting" | "failed" | "ended";
  durationSeconds: number;
  partial: boolean;
  formats: ("hls" | "mp4")[];
}
