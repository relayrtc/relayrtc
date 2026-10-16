"use server";

import { headers } from "next/headers";
import { z } from "zod";
import {
  createStreamSchema,
  updateStreamSchema,
  streamingIdSchema,
  streamScopeSchema,
} from "@relayrtc/validation";
import { reportingOrigin, sessionCookie } from "@/lib/reporting/request";
import {
  credentialSchema,
  detailSchema,
  grantSchema,
  operationSchema,
  pageSchema,
  playbackSchema,
  streamSchema,
  usageSchema,
  type StreamingResult,
} from "@/lib/streaming/contracts";

const scope = streamScopeSchema.required();
const resource = scope.extend({ streamId: streamingIdSchema });
const errorSchema = z.object({ code: z.string().max(100), description: z.string().max(600) });

async function requestStreaming<T>(
  projectId: string,
  environmentId: string,
  path: string,
  schema: z.ZodType<T>,
  method = "GET",
  body?: unknown,
  query: Record<string, string> = {},
  idempotencyKey?: string,
): Promise<StreamingResult<T>> {
  try {
    const cookie = sessionCookie((await headers()).get("cookie") ?? "");
    if (!cookie)
      return {
        data: null,
        error: { code: "AUTHENTICATION_REQUIRED", description: "Sign in to access streams." },
      };
    const requestHeaders: Record<string, string> = { cookie, accept: "application/json" };
    if (method !== "GET") {
      if (!process.env.BETTER_AUTH_URL) throw new Error("Console origin unavailable");
      requestHeaders.origin = new URL(process.env.BETTER_AUTH_URL).origin;
    }
    if (idempotencyKey) requestHeaders["idempotency-key"] = idempotencyKey;
    if (body !== undefined) requestHeaders["content-type"] = "application/json";
    const parameters = new URLSearchParams({ ...query, projectId, environmentId });
    const response = await fetch(new URL(`/v1/${path}?${parameters}`, reportingOrigin()), {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = errorSchema.safeParse(payload);
      if (error.success && response.status < 500) return { data: null, error: error.data };
      throw new Error("Streaming API unavailable");
    }
    return { data: schema.parse(payload), error: null };
  } catch {
    return {
      data: null,
      error: {
        code: "STREAMING_UNAVAILABLE",
        description: "Streaming is unavailable. Check that streaming is enabled or try again.",
      },
    };
  }
}
const invalid = {
  data: null,
  error: {
    code: "INVALID_STREAM_INPUT",
    description: "Check the stream configuration and selected environment.",
  },
} as const;

export async function listStreamsAction(input: unknown) {
  const parsed = scope.extend({ cursor: streamingIdSchema.optional() }).safeParse(input);
  if (!parsed.success) return invalid;
  const { projectId, environmentId, cursor } = parsed.data;
  return requestStreaming(projectId, environmentId, "streams", pageSchema, "GET", undefined, {
    limit: "30",
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
