export const clipEventTypes = [
  "clip.requested",
  "clip.rendering",
  "clip.ready",
  "clip.failed",
  "clip.deleted",
] as const;
export type ClipInterval =
  | { kind: "last"; seconds: number }
  | { kind: "media"; startSeconds: number; endSeconds: number }
  | { kind: "wall"; start: string; end: string };
export interface CreateClipInput {
  recordingId: string;
  interval: ClipInterval;
  cutMode?: "keyframe" | "precise";
  retentionSeconds?: number;
  label?: string;
}
export interface ClipResource {
  id: string;
  streamId: string;
  broadcastId: string;
  sourceRecordingId: string;
  recordingId: string;
  assetId: string;
  label: string;
  state: "queued" | "rendering" | "ready" | "failed" | "deleting" | "deleted";
  cutMode: "keyframe" | "precise";
  requestedStartSeconds: number;
  requestedEndSeconds: number;
  resolvedStartSeconds: number;
  resolvedEndSeconds: number;
  durationSeconds: number;
  published: boolean;
  lastError: string | null;
  storedBytes: number;
  processingSeconds: number;
  storageByteSeconds: number;
  createdAt: string;
  expiresAt: string | null;
}
export interface RollingBufferPolicy {
  enabled: boolean;
  durationSeconds: number;
  maxBytes: number;
  consentAcknowledged: boolean;
}
export interface ClipWindow {
  recordingId: string;
  broadcastId: string;
  kind: "recording" | "buffer";
  state: string;
  startSeconds: number;
  endSeconds: number;
  wallStart: string | null;
  wallEnd: string | null;
  storedBytes: number;
}
