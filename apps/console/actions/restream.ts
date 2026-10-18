"use server";
import { z } from "zod";
import {
  createRestreamSourceSchema,
  updateRestreamSourceSchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import {
  restreamDetailContract,
  restreamPageContract,
  restreamSourceContract,
} from "@/lib/streaming/restream-contracts";
const scope = streamScopeSchema.required(),
  resource = scope.extend({ sourceId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_SOURCE_INPUT",
    description: "Check the source configuration and selected environment.",
  },
} as const;
export async function listRestreamSourcesAction(input: unknown) {
  const p = scope.extend({ cursor: streamingIdSchema.optional() }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    "restream-sources",
    restreamPageContract,
    "GET",
    undefined,
    { limit: "100", ...(p.data.cursor ? { cursor: p.data.cursor } : {}) },
  );
}
export async function getRestreamSourceAction(input: unknown) {
  const p = resource.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `restream-sources/${p.data.sourceId}`,
    restreamDetailContract,
  );
}
export async function saveRestreamSourceAction(input: unknown) {
  const p = scope
    .extend({
      sourceId: streamingIdSchema.optional(),
      configuration: z.union([createRestreamSourceSchema, updateRestreamSourceSchema]),
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    p.data.sourceId ? `restream-sources/${p.data.sourceId}` : "restream-sources",
    restreamSourceContract,
    p.data.sourceId ? "PATCH" : "POST",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function commandRestreamSourceAction(input: unknown) {
  const p = resource
    .extend({ command: z.enum(["probe", "start", "stop"]), idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `restream-sources/${p.data.sourceId}/${p.data.command}`,
    restreamDetailContract,
    "POST",
    {},
    {},
    p.data.idempotencyKey,
  );
}
export async function deleteRestreamSourceAction(input: unknown) {
  const p = resource.extend({ idempotencyKey: z.string().uuid() }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `restream-sources/${p.data.sourceId}`,
    z.object({ id: z.string(), deleted: z.literal(true) }),
    "DELETE",
    undefined,
    {},
    p.data.idempotencyKey,
  );
}
