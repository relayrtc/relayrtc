"use server";
import { z } from "zod";
import { streamScopeSchema, streamingIdSchema } from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import { recordingPlaybackSchema, assetGrantSchema } from "@/lib/streaming/recording-contracts";
const scope = streamScopeSchema.required(), resource = scope.extend({ recordingId: streamingIdSchema });
const invalid = { data: null, error: { code: "INVALID_PREVIEW", description: "Check the selected media and environment." } } as const;
export async function getRecordingPlaybackAction(input: unknown) {
  const p = resource.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `recordings/${p.data.recordingId}/playback`,
    recordingPlaybackSchema,
  );
}
export async function createAssetGrantAction(input: unknown) {
  const p = scope
    .extend({
      assetId: streamingIdSchema,
      action: z.literal("playback"),
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `assets/${p.data.assetId}/access-grants`,
    assetGrantSchema,
    "POST",
    { action: p.data.action, ttlSeconds: 300, audience: "preview" },
    {},
    p.data.idempotencyKey,
  );
}
