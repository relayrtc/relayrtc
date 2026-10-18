"use server";
import { z } from "zod";
import {
  streamScopeSchema,
  streamingIdSchema,
  recordingPolicySchema,
  startRecordingSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import {
  recordingSchema,
  recordingPageSchema,
  recordingPlaybackSchema,
  assetGrantSchema,
} from "@/lib/streaming/recording-contracts";
const scope = streamScopeSchema.required(),
  resource = scope.extend({ recordingId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_RECORDING_INPUT",
    description: "Check the recording and selected environment.",
  },
} as const;
export async function listRecordingsAction(input: unknown) {
  const p = scope
    .extend({ cursor: streamingIdSchema.optional(), streamId: streamingIdSchema.optional() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    p.data.streamId ? `streams/${p.data.streamId}/recordings` : "recordings",
    recordingPageSchema,
    "GET",
    undefined,
    { limit: "30", ...(p.data.cursor ? { cursor: p.data.cursor } : {}) },
  );
}
export async function getRecordingAction(input: unknown) {
  const p = resource.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `recordings/${p.data.recordingId}`,
    recordingSchema,
  );
}
export async function startRecordingAction(input: unknown) {
  const p = scope
    .extend({
      streamId: streamingIdSchema,
      configuration: startRecordingSchema,
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/recordings`,
    recordingSchema,
    "POST",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function commandRecordingAction(input: unknown) {
  const p = resource
    .extend({ command: z.enum(["stop", "delete"]), idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `recordings/${p.data.recordingId}${p.data.command === "stop" ? "/stop" : ""}`,
    recordingSchema,
    p.data.command === "stop" ? "POST" : "DELETE",
    p.data.command === "stop" ? {} : undefined,
    {},
    p.data.idempotencyKey,
  );
}
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
      action: z.enum(["playback", "download"]),
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
export async function getRecordingPolicyAction(input: unknown) {
  const p = scope.extend({ streamId: streamingIdSchema }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/recording-policy`,
    z.object({ policy: recordingPolicySchema.nullable(), version: z.number() }),
  );
}
export async function setRecordingPolicyAction(input: unknown) {
  const p = scope
    .extend({
      streamId: streamingIdSchema,
      version: z.number().int().nonnegative(),
      policy: recordingPolicySchema,
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/recording-policy`,
    z.object({ policy: recordingPolicySchema, version: z.number() }),
    "PUT",
    { version: p.data.version, policy: p.data.policy },
    {},
    p.data.idempotencyKey,
  );
}
