import { z } from "zod";
import { streamingIdSchema } from "./streaming.js";
export const dvrPolicySchema = z
  .object({
    enabled: z.boolean(),
    durationSeconds: z.number().int().min(30).max(1800).default(300),
    maxBytes: z.number().int().min(16777216).max(536870912).default(134217728),
    endedRetentionSeconds: z.number().int().min(0).max(1800).default(300),
    consentAcknowledged: z.literal(true),
  })
  .strict();
export const configureDvrSchema = z.object({ policy: dvrPolicySchema }).strict();
export const updateDvrSchema = configureDvrSchema
  .extend({ version: z.number().int().positive() })
  .strict();
export const dvrPlaybackQuerySchema = z
  .object({
    projectId: z.string().optional(),
    environmentId: z.string().optional(),
    broadcastId: streamingIdSchema.optional(),
  })
  .strict();
export const dvrPolicyResourceSchema = z.object({
  policy: dvrPolicySchema.nullable(),
  version: z.number(),
  effective: z.literal("next-run; disabling drains current runs"),
});
export const dvrPlaybackSchema = z.object({
  streamId: z.string(),
  broadcastId: z.string().nullable(),
  windowId: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  generation: z.number().nullable(),
  state: z.enum(["starting", "live", "ended", "unavailable"]),
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
  wallStart: z.string().nullable(),
  wallEnd: z.string().nullable(),
  discontinuities: z.array(z.number()),
  expiresAt: z.string().nullable(),
  policyVersion: z.number().nullable(),
  storedBytes: z.number(),
  storageByteSeconds: z.number(),
  deliveredBytes: z.number(),
  storageAccounting: z.literal("shared-buffer; already metered by recording"),
  grantRequired: z.literal(true),
  renewal: z.string(),
  delivery: z.literal("rolling-hls-fmp4"),
  limits: z.object({ maxBuffers: z.number(), maxBuffersPerEnvironment: z.number() }),
});
