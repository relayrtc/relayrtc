"use server";

import { z } from "zod";
import {
  createStreamSchema,
  updateStreamSchema,
  streamingIdSchema,
  streamScopeSchema,
  serviceUsageReportSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import {
  credentialSchema,
  detailSchema,
  grantSchema,
  operationSchema,
  pageSchema,
  playbackSchema,
  streamSchema,
  usageSchema,
} from "@/lib/streaming/contracts";

const scope = streamScopeSchema.required();
const resource = scope.extend({ streamId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_STREAM_INPUT",
    description: "Check the stream configuration and selected environment.",
  },
} as const;

export async function listStreamsAction(input: unknown) {
  const parsed = scope
    .extend({
      cursor: streamingIdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, cursor, limit } = parsed.data;
  return requestStreaming(projectId, environmentId, "streams", pageSchema, "GET", undefined, {
    limit: String(limit),
    ...(cursor ? { cursor } : {}),
  });
}
export async function saveStreamAction(input: unknown) {
  const parsed = scope
    .extend({
      streamId: streamingIdSchema.optional(),
      configuration: z.unknown(),
      idempotencyKey: z.string().uuid().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId, configuration, idempotencyKey } = parsed.data;
  const body = (streamId ? updateStreamSchema : createStreamSchema).safeParse(configuration);
  if (!body.success) return invalid;
  return requestStreaming(
    projectId,
    environmentId,
    streamId ? `streams/${streamId}` : "streams",
    streamSchema,
    streamId ? "PATCH" : "POST",
    body.data,
    {},
    idempotencyKey,
  );
}
export async function getStreamAction(input: unknown) {
  const parsed = resource.safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    `streams/${parsed.data.streamId}`,
    detailSchema,
  );
}
export async function commandStreamAction(input: unknown) {
  const parsed = resource
    .extend({ command: z.enum(["start", "stop", "delete"]), idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId, command, idempotencyKey } = parsed.data;
  const suffix = command === "start" ? "/source-sessions" : command === "stop" ? "/stop" : "";
  return requestStreaming(
    projectId,
    environmentId,
    `streams/${streamId}${suffix}`,
    operationSchema,
    command === "delete" ? "DELETE" : "POST",
    {},
    {},
    idempotencyKey,
  );
}
export async function getStreamingOperationAction(input: unknown) {
  const parsed = scope.extend({ operationId: streamingIdSchema }).safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    `streaming-operations/${parsed.data.operationId}`,
    operationSchema,
  );
}
export async function createIngestCredentialAction(input: unknown) {
  const parsed = resource
    .extend({ credentialId: streamingIdSchema.optional(), idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, streamId, credentialId, idempotencyKey } = parsed.data;
  return requestStreaming(
    projectId,
    environmentId,
    `streams/${streamId}/ingest-credentials${credentialId ? `/${credentialId}/rotate` : ""}`,
    credentialSchema,
    "POST",
    {},
    {},
    idempotencyKey,
  );
}
export async function getStreamPlaybackAction(input: unknown) {
  const parsed = resource.safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    `streams/${parsed.data.streamId}/playback`,
    playbackSchema,
  );
}
export async function createStreamPlaybackGrantAction(input: unknown) {
  const parsed = resource.safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    `streams/${parsed.data.streamId}/playback-grants`,
    grantSchema,
    "POST",
    {},
  );
}
export async function getStreamUsageAction(input: unknown) {
  const parsed = resource.safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(
    parsed.data.projectId,
    parsed.data.environmentId,
    `streams/${parsed.data.streamId}/usage`,
    usageSchema,
  );
}

export async function getStreamUsageReportAction(input: unknown) {
  const parsed = resource.extend({ range: z.enum(["24h", "7d", "30d"]) }).safeParse(input);
  if (!parsed.success) return invalid;
  return requestStreaming(parsed.data.projectId, parsed.data.environmentId, `streams/${parsed.data.streamId}/usage-report`, serviceUsageReportSchema, "GET", undefined, { range: parsed.data.range });
}
