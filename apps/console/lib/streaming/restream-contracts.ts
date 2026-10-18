import { z } from "zod";
export const restreamSourceContract = z.object({
  id: z.string(),
  streamId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  name: z.string(),
  protocol: z.enum(["hls_pull", "rtmp_push", "whip_push"]),
  host: z.string().nullable(),
  profile: z.literal("h264_aac"),
  redistributionAuthorized: z.boolean(),
  reconnectBudget: z.number(),
  maxDurationSeconds: z.number(),
  maxBytes: z.number(),
  version: z.number(),
  secretConfigured: z.boolean(),
  state: z.enum([
    "created",
    "probing",
    "ready",
    "connecting",
    "live",
    "recovering",
    "stopped",
    "failed",
  ]),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const restreamDetailContract = restreamSourceContract.extend({
  session: z
    .object({
      id: z.string(),
      sourceId: z.string(),
      kind: z.enum(["probe", "pull", "push"]),
      state: z.string(),
      attempts: z.number(),
      fetchedBytes: z.number(),
      processingSeconds: z.number(),
      lastError: z.string().nullable(),
      createdAt: z.string(),
      endedAt: z.string().nullable(),
    })
    .nullable(),
  health: z.array(
    z.object({ state: z.string(), reason: z.string().nullable(), occurredAt: z.string() }),
  ),
  usage: z.object({
    fetchedBytes: z.number(),
    processingSeconds: z.number(),
    coverage: z.literal("observed"),
  }),
});
export const restreamPageContract = z.object({
  data: z.array(restreamSourceContract),
  nextCursor: z.string().nullable(),
});
export type ConsoleRestreamSource = z.infer<typeof restreamSourceContract>;
export type ConsoleRestreamDetail = z.infer<typeof restreamDetailContract>;
