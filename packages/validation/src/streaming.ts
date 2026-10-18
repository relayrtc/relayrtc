import { z } from "zod";

export const streamSourceInfoSchema = z
  .object({
    tracks: z
      .array(
        z
          .object({
            kind: z.enum(["audio", "video"]),
            codec: z.enum(["h264", "vp8", "vp9", "opus", "aac", "mp3"]),
            trackId: z.string().max(128).optional(),
            width: z.number().int().min(1).max(3840).optional(),
            height: z.number().int().min(1).max(2160).optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const streamingIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export const streamSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("room"),
      roomId: streamingIdSchema,
      videoTrackIds: z.array(streamingIdSchema).max(4).default([]),
      audioTrackIds: z.array(streamingIdSchema).max(8).default([]),
    })
    .strict(),
  z.object({ kind: z.literal("whip") }).strict(),
  z.object({ kind: z.literal("rtmp") }).strict(),
]);
export const streamProfileSchema = z
  .object({
    audioOnly: z.boolean().default(false),
    width: z.number().int().min(320).max(1920).multipleOf(2).default(1280),
    height: z.number().int().min(180).max(1080).multipleOf(2).default(720),
    fps: z.number().int().min(15).max(30).default(30),
    videoBitrate: z.number().int().min(200000).max(6000000).default(2500000),
    audioBitrate: z.number().int().min(64000).max(192000).default(128000),
    layout: z.enum(["single", "grid"]).default("single"),
  })
  .strict();
export const createStreamSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    source: streamSourceSchema,
    profile: streamProfileSchema.default(() => streamProfileSchema.parse({})),
    maxDurationSeconds: z.number().int().min(60).max(86400).default(14400),
    retentionSeconds: z.number().int().min(60).max(86400).default(300),
  })
  .strict();
export const updateStreamSchema = createStreamSchema
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export const streamScopeSchema = z.object({
  projectId: streamingIdSchema.optional(),
  environmentId: streamingIdSchema.optional(),
});
export const listStreamsSchema = streamScopeSchema
  .extend({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: streamingIdSchema.optional(),
  })
  .strict();
export const ingestCredentialSchema = z
  .object({ ttlSeconds: z.number().int().min(60).max(86400).default(3600) })
  .strict();
export const playbackGrantSchema = z
  .object({ ttlSeconds: z.number().int().min(30).max(3600).default(300), mode: z.enum(["live", "dvr"]).default("live"), broadcastId: streamingIdSchema.optional() })
  .strict();
export const streamingObjectNameSchema = z
  .string()
  .max(180)
  .regex(/^[A-Za-z0-9_-]+\.(?:m3u8|mp4|m4s|ts)$/u);
