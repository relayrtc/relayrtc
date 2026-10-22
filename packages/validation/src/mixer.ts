import { z } from "zod";
import { streamingIdSchema } from "./streaming.js";
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/u);
const box = {
  x: z.number().int().min(0).max(638),
  y: z.number().int().min(0).max(358),
  width: z.number().int().min(2).max(640),
  height: z.number().int().min(2).max(360),
  z: z.number().int().min(0).max(15),
  opacity: z.number().min(0).max(1).default(1),
};
const inside = (b: { x: number; y: number; width: number; height: number }) =>
  b.x + b.width <= 640 && b.y + b.height <= 360;
export const mixerSourceSchema = z
  .object({ id: streamingIdSchema.refine((id) => id !== "primary"), streamId: streamingIdSchema })
  .strict();
export const mixerSceneSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    layout: z.enum(["single", "grid", "pip", "custom"]).default("single"),
    background: color.default("#000000"),
    layers: z
      .array(
        z
          .object({
            sourceId: streamingIdSchema,
            ...box,
            fit: z.enum(["contain", "cover"]).default("contain"),
          })
          .strict()
          .refine(inside),
      )
      .max(4),
    overlays: z
      .array(
        z
          .object({ overlayId: streamingIdSchema, ...box })
          .strict()
          .refine(inside),
      )
      .max(4)
      .default([]),
    texts: z
      .array(
        z
          .object({
            id: streamingIdSchema,
            text: z
              .string()
              .min(1)
              .max(120)
              .refine((s) =>
                Array.from(s).every((c) => {
                  const point = c.codePointAt(0) ?? 0;
                  return point >= 32 && (point < 127 || point > 159);
                }),
              ),
            ...box,
            fontSize: z.number().int().min(10).max(48).default(24),
            color: color.default("#ffffff"),
          })
          .strict()
          .refine(inside),
      )
      .max(4)
      .default([]),
    audio: z
      .array(
        z
          .object({
            sourceId: streamingIdSchema,
            gainDb: z.number().min(-60).max(12).default(0),
            muted: z.boolean().default(false),
          })
          .strict(),
      )
      .max(4)
      .default([]),
    ducking: z
      .object({
        sourceId: streamingIdSchema,
        threshold: z.number().min(0.01).max(1).default(0.1),
        attenuationDb: z.number().min(0).max(30).default(12),
      })
      .strict()
      .nullable()
      .default(null),
    transition: z.literal("cut").default("cut"),
  })
  .strict()
  .superRefine((scene, ctx) => {
    const ids = scene.audio.map((a) => a.sourceId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Audio sources must be unique" });
    if (scene.ducking && !ids.includes(scene.ducking.sourceId))
      ctx.addIssue({ code: "custom", message: "Ducking source must be in the audio mix" });
    const zOrder = [...scene.layers, ...scene.overlays, ...scene.texts].map((l) => l.z);
    if (new Set(zOrder).size !== zOrder.length)
      ctx.addIssue({ code: "custom", message: "Layer z-order must be unique" });
  });
export const createMixerSchema = z
  .object({ sources: z.array(mixerSourceSchema).max(3).default([]) })
  .strict()
  .refine(
    (v) =>
      new Set(v.sources.map((s) => s.id)).size === v.sources.length &&
      new Set(v.sources.map((s) => s.streamId)).size === v.sources.length,
  );
export const putMixerSceneSchema = z
  .object({ version: z.number().int().nonnegative(), scene: mixerSceneSchema })
  .strict();
export const activateMixerSceneSchema = z
  .object({
    version: z.number().int().positive(),
    sceneId: streamingIdSchema,
    sceneVersion: z.number().int().positive(),
  })
  .strict();
export const createMixerOverlaySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    contentType: z.literal("image/png"),
    dataBase64: z
      .string()
      .min(1)
      .max(1398104)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  })
  .strict();
export const mixerReportSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sceneId: streamingIdSchema.nullable(),
    frames: z.number().int().nonnegative(),
    inputSeconds: z.number().nonnegative().refine(Number.isFinite).optional(),
    lostSources: z.array(streamingIdSchema).max(4),
    overloaded: z.boolean(),
    preparationFailed: z.boolean().default(false),
  })
  .strict();
export const mixerOverlaySchema = z.object({
  id: z.string(),
  name: z.string(),
  width: z.number(),
  height: z.number(),
  sizeBytes: z.number(),
});
export const mixerSceneResourceSchema = z.object({
  id: z.string(),
  mixerId: z.string(),
  version: z.number(),
  scene: mixerSceneSchema,
});
export const mixerOperationSchema = z.object({
  id: z.string(),
  mixerId: z.string(),
  kind: z.enum(["activate", "stop"]),
  revision: z.number(),
  status: z.enum(["pending", "completed", "failed"]),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export const mixerResourceSchema = z.object({
  id: z.string(),
  broadcastId: z.string(),
  streamId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  state: z.enum(["created", "preparing", "live", "degraded", "stopping", "stopped", "failed"]),
  version: z.number(),
  desiredVersion: z.number(),
  appliedVersion: z.number(),
  desiredSceneId: z.string().nullable(),
  appliedSceneId: z.string().nullable(),
  sources: z.array(z.object({ id: z.string(), streamId: z.string() })),
  overlays: z.array(mixerOverlaySchema),
  lostSources: z.array(z.string()),
  lastError: z.string().nullable(),
  usage: z.object({
    renderSeconds: z.number(),
    programSeconds: z.number(),
    inputSeconds: z.number(),
    frames: z.number(),
  }),
  limits: z.object({
    canvasWidth: z.number(),
    canvasHeight: z.number(),
    fps: z.number(),
    maxInputs: z.number(),
    maxLayers: z.number(),
    gpu: z.boolean(),
  }),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export const mixerCommandResultSchema = z.object({
  mixer: mixerResourceSchema,
  operation: mixerOperationSchema,
});
