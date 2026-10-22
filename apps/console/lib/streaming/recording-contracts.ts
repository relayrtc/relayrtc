import { z } from "zod";
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
