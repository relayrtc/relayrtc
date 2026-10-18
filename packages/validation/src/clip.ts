import { z } from "zod";
import { streamingIdSchema } from "./streaming.js";
export const clipIntervalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("last"), seconds: z.number().positive().max(120) }).strict(),
  z
    .object({
      kind: z.literal("media"),
      startSeconds: z.number().nonnegative(),
      endSeconds: z.number().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("wall"), start: z.iso.datetime(), end: z.iso.datetime() }).strict(),
]);
export const createClipSchema = z
  .object({
    recordingId: streamingIdSchema,
    interval: clipIntervalSchema,
    cutMode: z.enum(["keyframe", "precise"]).default("keyframe"),
    retentionSeconds: z.number().int().min(3600).max(7776000).default(604800),
    label: z.string().trim().max(100).default(""),
  })
  .strict();
export const rollingBufferPolicySchema = z
  .object({
    enabled: z.boolean(),
    durationSeconds: z.number().int().min(30).max(1800).default(300),
    maxBytes: z.number().int().min(16777216).max(536870912).default(134217728),
    consentAcknowledged: z.literal(true),
  })
  .strict();

export const clipResourceSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  broadcastId: z.string(),
  sourceRecordingId: z.string(),
  recordingId: z.string(),
  assetId: z.string(),
  label: z.string(),
  state: z.enum(["queued", "rendering", "ready", "failed", "deleting", "deleted"]),
  cutMode: z.enum(["keyframe", "precise"]),
  requestedStartSeconds: z.number(),
  requestedEndSeconds: z.number(),
  resolvedStartSeconds: z.number(),
  resolvedEndSeconds: z.number(),
  durationSeconds: z.number(),
  published: z.boolean(),
  lastError: z.string().nullable(),
  storedBytes: z.number(),
  processingSeconds: z.number(),
  storageByteSeconds: z.number(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export const clipWindowSchema = z.object({
  recordingId: z.string(),
  broadcastId: z.string(),
  kind: z.enum(["recording", "buffer"]),
  state: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  wallStart: z.string().nullable(),
  wallEnd: z.string().nullable(),
  storedBytes: z.number(),
});
