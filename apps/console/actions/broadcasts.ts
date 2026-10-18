"use server";
import { z } from "zod";
import {
  createBroadcastSchema,
  broadcastCommandSchema,
  listBroadcastsSchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import { operationSchema } from "@/lib/streaming/contracts";
import {
  broadcastDetailSchema,
  broadcastOutputsSchema,
  broadcastPageSchema,
  broadcastSchema,
} from "@/lib/streaming/broadcast-contracts";
const scope = streamScopeSchema.required();
const resource = scope.extend({ broadcastId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_BROADCAST_INPUT",
    description: "Check the broadcast and selected environment.",
  },
} as const;
export async function listBroadcastsAction(input: unknown) {
  const parsed = scope
    .extend({
      cursor: streamingIdSchema.optional(),
      state: listBroadcastsSchema.shape.state,
      streamId: streamingIdSchema.optional(),
      activeOnly: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, cursor, state, streamId, activeOnly } = parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    "broadcasts",
    broadcastPageSchema,
    "GET",
    undefined,
    {
      limit: "30",
      order: "newest",
      ...(activeOnly ? { activeOnly: "true" } : {}),
      ...(cursor ? { cursor } : {}),
      ...(state ? { state } : {}),
      ...(streamId ? { streamId } : {}),
    },
  );
}
export async function createBroadcastAction(input: unknown) {
  const parsed = scope
    .extend({ configuration: createBroadcastSchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    "broadcasts",
    broadcastSchema,
    "POST",
    parsed.data.configuration,
    {},
    parsed.data.idempotencyKey,
  );
}
export async function getBroadcastAction(input: unknown) {
  const parsed = resource.safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    `broadcasts/${parsed.data.broadcastId}`,
    broadcastDetailSchema,
  );
}
export async function getBroadcastOutputsAction(input: unknown) {
  const parsed = resource.safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    `broadcasts/${parsed.data.broadcastId}/outputs`,
    broadcastOutputsSchema,
  );
}
export async function commandBroadcastAction(input: unknown) {
  const parsed = resource
    .extend({
      command: z.enum(["start", "stop"]),
      version: broadcastCommandSchema.shape.version,
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, broadcastId, command, version, idempotencyKey } = parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `broadcasts/${broadcastId}/${command}`,
    operationSchema,
    "POST",
    version === undefined ? {} : { version },
    {},
    idempotencyKey,
  );
}
