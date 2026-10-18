export const restreamEventTypes = [
  "restream.probing",
  "restream.source_connected",
  "restream.source_lost",
  "restream.recovering",
  "restream.stopped",
  "restream.failed",
] as const;
export type RestreamProtocol = "hls_pull" | "rtmp_push" | "whip_push";
export type RestreamState =
  "created" | "probing" | "ready" | "connecting" | "live" | "recovering" | "stopped" | "failed";
export interface RestreamSource {
  id: string;
  streamId: string;
  projectId: string;
  environmentId: string;
  name: string;
  protocol: RestreamProtocol;
  host: string | null;
  profile: "h264_aac";
  redistributionAuthorized: boolean;
  reconnectBudget: number;
  maxDurationSeconds: number;
  maxBytes: number;
  version: number;
  secretConfigured: boolean;
  state: RestreamState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface RestreamSession {
  id: string;
  sourceId: string;
  kind: "probe" | "pull" | "push";
  state: RestreamState;
  attempts: number;
  fetchedBytes: number;
  processingSeconds: number;
  lastError: string | null;
  createdAt: string;
  endedAt: string | null;
}
export interface RestreamDetail extends RestreamSource {
  session: RestreamSession | null;
  health: { state: RestreamState; reason: string | null; occurredAt: string }[];
  usage: { fetchedBytes: number; processingSeconds: number; coverage: "observed" };
}
export interface CreateRestreamSourceInput {
  streamId: string;
  name: string;
  protocol: RestreamProtocol;
  endpoint?: string;
  authorization?: string;
  redistributionAuthorized: true;
  reconnectBudget?: number;
  maxDurationSeconds?: number;
  maxBytes?: number;
}
export interface UpdateRestreamSourceInput {
  version: number;
  name?: string;
  endpoint?: string;
  authorization?: string;
  redistributionAuthorized?: true;
  reconnectBudget?: number;
  maxDurationSeconds?: number;
  maxBytes?: number;
}
