"use server";
import { z } from "zod";
import {
  createClipSchema,
  rollingBufferPolicySchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import { clipSchema, clipWindowSchema } from "@/lib/streaming/clip-contracts";
const scope = streamScopeSchema.required(),
  stream = scope.extend({ streamId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_CLIP_INPUT",
    description: "Check the clip interval and selected environment.",
  },
} as const;
export async function listClipsAction(input: unknown) {
  const p = stream.extend({ cursor: streamingIdSchema.optional() }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/clips`,
    z.object({ data: z.array(clipSchema), nextCursor: z.string().nullable() }),
    "GET",
    undefined,
    { ...(p.data.cursor ? { cursor: p.data.cursor } : {}) },
  );
}
export async function clipWindowAction(input: unknown) {
  const p = stream.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/clip-window`,
    z.object({ data: z.array(clipWindowSchema) }),
  );
}
export async function createClipAction(input: unknown) {
  const p = stream
    .extend({ configuration: createClipSchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/clips`,
    clipSchema,
    "POST",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function commandClipAction(input: unknown) {
  const p = scope
    .extend({
      clipId: streamingIdSchema,
      command: z.enum(["publish", "delete"]),
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `clips/${p.data.clipId}${p.data.command === "publish" ? "/publish" : ""}`,
    clipSchema,
    p.data.command === "publish" ? "POST" : "DELETE",
    p.data.command === "publish" ? {} : undefined,
    {},
    p.data.idempotencyKey,
  );
}
export async function bufferPolicyAction(input: unknown) {
  const p = stream
    .extend({
      configuration: z
        .object({ version: z.number().int().nonnegative(), policy: rollingBufferPolicySchema })
        .optional(),
      idempotencyKey: z.string().uuid().optional(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/buffer-policy`,
    z.object({ version: z.number(), policy: rollingBufferPolicySchema.nullable() }),
    p.data.configuration ? "PUT" : "GET",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}

export async function getClipAction(input: unknown) {
  const p = scope.extend({ clipId: streamingIdSchema }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `clips/${p.data.clipId}`,
    clipSchema,
  );
}
