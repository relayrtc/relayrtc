import { z } from "zod";
import { streamingIdSchema } from "./streaming.js";
export const recordingPolicySchema = z
  .object({
    mode: z.enum(["manual", "automatic"]).default("manual"),
    maxDurationSeconds: z.number().int().min(10).max(86400).default(14400),
    retentionSeconds: z.number().int().min(3600).max(7776000).default(604800),
    region: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/u)
      .default("us-east-1"),
    allowPartial: z.boolean().default(false),
    exportMp4: z.boolean().default(true),
    segmentEvents: z.boolean().default(false),
    consentAcknowledged: z.literal(true),
  })
  .strict();
export const startRecordingSchema = z
  .object({
    broadcastId: streamingIdSchema.optional(),
    policy: recordingPolicySchema,
  })
  .strict();
export const assetAccessGrantSchema = z
  .object({
    audience: z.enum(["preview", "viewer"]).default("viewer"),
    action: z.enum(["playback", "download"]).default("playback"),
    ttlSeconds: z.number().int().min(30).max(3600).default(300),
  })
  .strict();
