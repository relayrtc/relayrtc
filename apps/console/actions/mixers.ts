"use server";
import { z } from "zod";
import {
  createMixerSchema,
  putMixerSceneSchema,
  activateMixerSceneSchema,
  createMixerOverlaySchema,
  mixerResourceSchema,
  mixerSceneResourceSchema,
  mixerCommandResultSchema,
  mixerOperationSchema,
  mixerOverlaySchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
const scope = streamScopeSchema.required(),
  resource = scope.extend({ mixerId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_MIXER_INPUT",
    description: "Check the selected mixer, scene and environment.",
  },
} as const;
export async function listMixersAction(input: unknown) {
  const p = scope.extend({ broadcastId: streamingIdSchema }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `broadcasts/${p.data.broadcastId}/mixers`,
    z.object({ data: z.array(mixerResourceSchema) }),
  );
}
export async function getMixerAction(input: unknown) {
  const p = resource.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixers/${p.data.mixerId}`,
    mixerResourceSchema,
  );
}
export async function createMixerAction(input: unknown) {
  const p = scope
    .extend({
      broadcastId: streamingIdSchema,
      configuration: createMixerSchema,
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `broadcasts/${p.data.broadcastId}/mixers`,
    mixerResourceSchema,
    "POST",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function listMixerScenesAction(input: unknown) {
  const p = resource.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixers/${p.data.mixerId}/scenes`,
    z.object({ data: z.array(mixerSceneResourceSchema) }),
  );
}
export async function saveMixerSceneAction(input: unknown) {
  const p = resource
    .extend({
      sceneId: streamingIdSchema,
      configuration: putMixerSceneSchema,
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixers/${p.data.mixerId}/scenes/${p.data.sceneId}`,
    mixerSceneResourceSchema,
    "PUT",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function activateMixerSceneAction(input: unknown) {
  const p = resource
    .extend({ configuration: activateMixerSceneSchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixers/${p.data.mixerId}/activate-scene`,
    mixerCommandResultSchema,
    "POST",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function stopMixerAction(input: unknown) {
  const p = resource
    .extend({ version: z.number().int().positive(), idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixers/${p.data.mixerId}/stop`,
    mixerCommandResultSchema,
    "POST",
    { version: p.data.version },
    {},
    p.data.idempotencyKey,
  );
}
export async function getMixerOperationAction(input: unknown) {
  const p = scope.extend({ operationId: streamingIdSchema }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixer-operations/${p.data.operationId}`,
    mixerOperationSchema,
  );
}
export async function addMixerOverlayAction(input: unknown) {
  const p = resource
    .extend({ configuration: createMixerOverlaySchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixers/${p.data.mixerId}/overlays`,
    mixerOverlaySchema,
    "POST",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function removeMixerOverlayAction(input: unknown) {
  const p = resource
    .extend({ overlayId: streamingIdSchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `mixers/${p.data.mixerId}/overlays/${p.data.overlayId}`,
    z.object({ id: z.string(), deleted: z.literal(true) }),
    "DELETE",
    undefined,
    {},
    p.data.idempotencyKey,
  );
}
