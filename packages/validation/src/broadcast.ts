import { z } from "zod";
import { streamingIdSchema, streamScopeSchema } from "./streaming.js";

export const createBroadcastSchema = z
  .object({
    streamId: streamingIdSchema,
    destinationIds: z
      .array(streamingIdSchema)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
    name: z.string().trim().min(1).max(120),
    outputs: z
      .array(z.object({ kind: z.literal("hls") }).strict())
      .length(1)
      .default([{ kind: "hls" }]),
    waitTimeoutSeconds: z.number().int().min(10).max(600).default(120),
    maxDurationSeconds: z.number().int().min(60).max(86400).default(14400),
  })
  .strict();
export const listBroadcastsSchema = streamScopeSchema
  .extend({
    cursor: streamingIdSchema.optional(),
    order: z.enum(["id", "newest"]).default("id"),
    activeOnly: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    streamId: streamingIdSchema.optional(),
    state: z
      .enum([
        "created",
        "waiting_for_source",
        "starting",
        "live",
        "reconnecting",
        "degraded",
        "stopping",
        "stopped",
        "failed",
      ])
      .optional(),
  })
  .strict();
export const broadcastCommandSchema = z
  .object({ version: z.number().int().positive().optional() })
  .strict();
