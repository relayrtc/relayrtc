import { z } from "zod";
import { recordingPolicySchema } from "@relayrtc/validation";
export const recordingSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  broadcastId: z.string(),
  assetId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  state: z.enum(["queued", "recording", "finalizing", "ready", "failed", "deleting", "deleted"]),
  policy: recordingPolicySchema,
  partial: z.boolean(),
  lastError: z.string().nullable(),
  durationSeconds: z.number(),
  storedBytes: z.number(),
  storageByteSeconds: z.number(),
  processingSeconds: z.number(),
  segmentCount: z.number(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export const recordingPageSchema = z.object({
  data: z.array(recordingSchema),
  nextCursor: z.string().nullable(),
});
export const recordingPlaybackSchema = z.object({
  mode: z.literal("vod"),
  recordingId: z.string(),
  assetId: z.string(),
  streamId: z.string(),
  sourceSessionId: z.string(),
  generation: z.number(),
  state: z.enum(["ready", "starting", "failed", "ended"]),
  durationSeconds: z.number(),
  partial: z.boolean(),
  formats: z.array(z.enum(["hls", "mp4"])),
});
export const assetGrantSchema = z.object({
  assetId: z.string(),
  action: z.enum(["playback", "download"]),
  url: z.url(),
  expiresAt: z.string(),
});
export type ConsoleRecording = z.infer<typeof recordingSchema>;
