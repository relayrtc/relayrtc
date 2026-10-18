"use server";
import { z } from "zod";
import {
  createScheduleSchema,
  updateScheduleSchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
import {
  scheduledBroadcastSchema,
  schedulePageSchema,
  scheduledPlaybackSchema,
} from "@/lib/streaming/schedule-contracts";
const scope = streamScopeSchema.required(),
  resource = scope.extend({ scheduleId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_SCHEDULE_INPUT",
    description: "Check the UTC times, schedule and selected environment.",
  },
} as const;
export async function listSchedulesAction(input: unknown) {
  const p = scope
    .extend({ cursor: streamingIdSchema.optional(), streamId: streamingIdSchema.optional() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    "scheduled-broadcasts",
    schedulePageSchema,
    "GET",
    undefined,
    {
      limit: "30",
      ...(p.data.cursor ? { cursor: p.data.cursor } : {}),
      ...(p.data.streamId ? { streamId: p.data.streamId } : {}),
    },
  );
}
export async function getScheduleAction(input: unknown) {
  const p = resource.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `scheduled-broadcasts/${p.data.scheduleId}`,
    scheduledBroadcastSchema,
  );
}
export async function createScheduleAction(input: unknown) {
  const p = scope
    .extend({ configuration: createScheduleSchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    "scheduled-broadcasts",
    scheduledBroadcastSchema,
    "POST",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function updateScheduleAction(input: unknown) {
  const p = resource
    .extend({ configuration: updateScheduleSchema, idempotencyKey: z.string().uuid() })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `scheduled-broadcasts/${p.data.scheduleId}`,
    scheduledBroadcastSchema,
    "PATCH",
    p.data.configuration,
    {},
    p.data.idempotencyKey,
  );
}
export async function commandScheduleAction(input: unknown) {
  const p = resource
    .extend({
      command: z.enum(["cancel", "start-now"]),
      version: z.number().int().positive(),
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `scheduled-broadcasts/${p.data.scheduleId}/${p.data.command}`,
    scheduledBroadcastSchema,
    "POST",
    { version: p.data.version },
    {},
    p.data.idempotencyKey,
  );
}
export async function getScheduledPlaybackAction(input: unknown) {
  const p = resource.safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `scheduled-broadcasts/${p.data.scheduleId}/playback`,
    scheduledPlaybackSchema,
  );
}
export async function createScheduledGrantAction(input: unknown) {
  const p = resource.extend({ idempotencyKey: z.string().uuid() }).safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `scheduled-broadcasts/${p.data.scheduleId}/playback-grants`,
    z.object({ url: z.url(), expiresAt: z.string(), token: z.string() }),
    "POST",
    { ttlSeconds: 300 },
    {},
    p.data.idempotencyKey,
  );
}
