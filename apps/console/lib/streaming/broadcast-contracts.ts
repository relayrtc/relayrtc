import { z } from "zod";
export const broadcastSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  name: z.string(),
  state: z.enum([
    "created",
    "waiting_for_source",
    "starting",
    "live",
    "reconnecting",
    "degraded",
    "stopping",
    "stopped",
    "failed",
  ]),
  desiredState: z.enum(["idle", "running", "stopped"]),
  version: z.number().int(),
  sourceSessionId: z.string().nullable(),
  sourceGeneration: z.number().nullable(),
  lastError: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string(),
  startRequestedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export const broadcastDetailSchema = broadcastSchema.extend({
  usage: z.object({
    bytes: z.number(),
    transcodeSeconds: z.number(),
    runSeconds: z.number(),
    outputSeconds: z.number(),
    reservationSeconds: z.number(),
    samples: z.number(),
    coverage: z.enum(["observed", "partial"]),
  }),
});
export const broadcastPageSchema = z.object({
  data: z.array(broadcastSchema),
  nextCursor: z.string().nullable(),
  limits: z.object({
    activeRuns: z.number(),
    maxActiveRuns: z.number(),
    reservedOutputs: z.number(),
  }),
});
export const broadcastOutputsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      broadcastId: z.string(),
      kind: z.enum(["hls", "rtmp"]),
      destinationId: z.string().nullable(),
      destinationName: z.string().nullable(),
      outputSeconds: z.number(),
      bytes: z.number(),
      bitrate: z.number(),
      droppedFrames: z.number(),
      transcodeSeconds: z.number(),
      state: z.enum(["queued", "running", "retry", "stopping", "completed", "failed", "cancelled"]),
      attempts: z.number(),
      fence: z.number(),
      lastError: z.string().nullable(),
      lastHeartbeatAt: z.string().nullable(),
      sourceSessionId: z.string().nullable(),
      sourceGeneration: z.number().nullable(),
    }),
  ),
});
export type ConsoleBroadcast = z.infer<typeof broadcastSchema>;
export type ConsoleBroadcastDetail = z.infer<typeof broadcastDetailSchema>;
