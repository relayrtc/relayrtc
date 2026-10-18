"use server";
import { z } from "zod";
import {
  createDestinationSchema,
  updateDestinationSchema,
  rotateDestinationSecretSchema,
  streamScopeSchema,
  streamingIdSchema,
  broadcastCommandSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import { destinationSchema, destinationPageSchema } from "@/lib/streaming/destination-contracts";
import { operationSchema } from "@/lib/streaming/contracts";
const scope = streamScopeSchema.required().extend({ streamId: streamingIdSchema });
const command = scope.extend({
  destinationId: streamingIdSchema,
  idempotencyKey: z.string().uuid(),
});
const invalid = {
  data: null,
  error: {
    code: "INVALID_DESTINATION_INPUT",
    description: "Check the destination configuration and selected environment.",
  },
} as const;
export async function listDestinationsAction(input: unknown) {
  const parsed = scope.safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId } = parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `streams/${streamId}/destinations`,
    destinationPageSchema,
  );
}
export async function createDestinationAction(input: unknown) {
  const parsed = scope
    .extend({ configuration: createDestinationSchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId, configuration, idempotencyKey } = parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `streams/${streamId}/destinations`,
    destinationSchema,
    "POST",
    configuration,
    {},
    idempotencyKey,
  );
}
export async function updateDestinationAction(input: unknown) {
  const parsed = command.extend({ configuration: updateDestinationSchema }).safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId, destinationId, configuration, idempotencyKey } =
    parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `streams/${streamId}/destinations/${destinationId}`,
    destinationSchema,
    "PATCH",
    configuration,
    {},
    idempotencyKey,
  );
}
export async function rotateDestinationSecretAction(input: unknown) {
  const parsed = command.extend({ configuration: rotateDestinationSecretSchema }).safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId, destinationId, configuration, idempotencyKey } =
    parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `streams/${streamId}/destinations/${destinationId}/rotate-secret`,
    destinationSchema,
    "POST",
    configuration,
    {},
    idempotencyKey,
  );
}
export async function deleteDestinationAction(input: unknown) {
  const parsed = command.safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId, destinationId, idempotencyKey } = parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `streams/${streamId}/destinations/${destinationId}`,
    z.object({ id: z.string(), deleted: z.literal(true) }),
    "DELETE",
    undefined,
    {},
    idempotencyKey,
  );
}
export async function retryBroadcastOutputAction(input: unknown) {
  const parsed = streamScopeSchema
    .required()
    .extend({
      broadcastId: streamingIdSchema,
      outputId: streamingIdSchema,
      version: broadcastCommandSchema.shape.version,
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, broadcastId, outputId, version, idempotencyKey } = parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `broadcasts/${broadcastId}/outputs/${outputId}/retry`,
    operationSchema,
    "POST",
    version === undefined ? {} : { version },
    {},
    idempotencyKey,
  );
}
