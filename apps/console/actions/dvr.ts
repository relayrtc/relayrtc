"use server";
import { z } from "zod";
import {
  streamScopeSchema,
  streamingIdSchema,
  dvrPolicyResourceSchema,
  dvrPlaybackSchema,
  configureDvrSchema,
  updateDvrSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
const scope = streamScopeSchema.required().extend({ streamId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_DVR_INPUT",
    description: "Check the DVR policy and selected environment.",
  },
} as const;
export async function dvrPolicyAction(input: unknown) {
  const p = scope
    .extend({
      configuration: configureDvrSchema.or(updateDvrSchema).optional(),
      idempotencyKey: z.string().uuid().optional(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  const configuration = p.data.configuration;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/dvr-policy`,
    dvrPolicyResourceSchema,
    configuration ? ("version" in configuration ? "PATCH" : "POST") : "GET",
    configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function dvrPlaybackAction(input: unknown) {
  const p = scope.extend({ broadcastId: streamingIdSchema.optional() }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/dvr-playback`,
    dvrPlaybackSchema,
    "GET",
    undefined,
    p.data.broadcastId ? { broadcastId: p.data.broadcastId } : {},
  );
}
export async function dvrGrantAction(input: unknown) {
  const p = scope.extend({ broadcastId: streamingIdSchema.optional() }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/playback-grants`,
    z.object({ url: z.string().url(), expiresAt: z.string(), token: z.string() }),
    "POST",
    { mode: "dvr", ...(p.data.broadcastId ? { broadcastId: p.data.broadcastId } : {}) },
  );
}
