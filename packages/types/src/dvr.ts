export interface DvrPolicy {
  enabled: boolean;
  durationSeconds: number;
  maxBytes: number;
  endedRetentionSeconds: number;
  consentAcknowledged: true;
}
export interface DvrPolicyResource {
  policy: DvrPolicy | null;
  version: number;
  effective: "next-run; disabling drains current runs";
}
export interface DvrPlayback {
  streamId: string;
  broadcastId: string | null;
  windowId: string | null;
  sourceSessionId: string | null;
  generation: number | null;
  state: "starting" | "live" | "ended" | "unavailable";
  startSeconds: number | null;
  endSeconds: number | null;
  wallStart: string | null;
  wallEnd: string | null;
  discontinuities: number[];
  expiresAt: string | null;
  policyVersion: number | null;
  storedBytes: number;
  storageByteSeconds: number;
  deliveredBytes: number;
  storageAccounting: "shared-buffer; already metered by recording";
  grantRequired: true;
  renewal: string;
  delivery: "rolling-hls-fmp4";
  limits: { maxBuffers: number; maxBuffersPerEnvironment: number };
}
