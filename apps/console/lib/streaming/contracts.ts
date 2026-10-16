import { z } from "zod";
import {
  streamProfileSchema,
  streamSourceSchema,
  streamSourceInfoSchema,
} from "@relayrtc/validation";

export const streamSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  source: streamSourceSchema,
  profile: streamProfileSchema,
  status: z.enum(["active", "deleting", "deleted"]),
  version: z.number(),
  playbackEpoch: z.number(),
  maxDurationSeconds: z.number(),
  retentionSeconds: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const sessionSchema = z.object({
  id: z.string(),
  state: z.enum(["starting", "live", "reconnecting", "stopping", "ended", "failed"]),
  generation: z.number(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  ingressBitrate: z.number(),
  programBitrate: z.number(),
  sourceInfo: streamSourceInfoSchema,
});
export const detailSchema = streamSchema.extend({ sessions: z.array(sessionSchema) });
export const pageSchema = z.object({
  data: z.array(streamSchema),
  nextCursor: z.string().nullable(),
});
export const operationSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  kind: z.enum(["start", "stop", "delete"]),
  status: z.enum(["pending", "completed", "failed"]),
  errorCode: z.string().nullable(),
});
export const playbackSchema = z.object({
  streamId: z.string(),
  sourceSessionId: z.string().nullable(),
  generation: z.number().nullable(),
  state: z.enum(["ready", "starting", "live", "reconnecting", "stopping", "ended", "failed"]),
});
export const grantSchema = z.object({ url: z.url(), expiresAt: z.string(), token: z.string() });
export const credentialSchema = z.object({
  id: z.string(),
  expiresAt: z.string(),
  secret: z.string(),
  protocol: z.enum(["whip", "rtmp"]),
  url: z.url(),
});
export const usageSchema = z.object({
  streamId: z.string(),
  sourceSeconds: z.number(),
  ingressBytes: z.number(),
  programBytes: z.number(),
  samples: z.number(),
  coverage: z.enum(["observed", "partial"]),
});
export type ConsoleStream = z.infer<typeof streamSchema>;
export type ConsoleStreamDetail = z.infer<typeof detailSchema>;
export type ConsoleStreamingOperation = z.infer<typeof operationSchema>;
export type ConsoleIngestCredential = z.infer<typeof credentialSchema>;
export type StreamingResult<T> =
  { data: T; error: null } | { data: null; error: { code: string; description: string } };
