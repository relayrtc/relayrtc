"use server";
import { z } from "zod";
import {
  streamScopeSchema,
  streamingIdSchema,
  guestStageSchema,
  guestRosterSchema,
  guestResourceSchema,
  inviteGuestSchema,
  guestDecisionSchema,
  guestMuteSchema,
} from "@relayrtc/validation";
import { requestStreaming } from "@/lib/streaming/client";
const scope = streamScopeSchema
  .required()
  .extend({ streamId: streamingIdSchema, broadcastId: streamingIdSchema });
const invalid = {
  data: null,
  error: {
    code: "INVALID_GUEST_INPUT",
    description: "Check the guest action and selected broadcast.",
  },
} as const;
export async function guestStageAction(input: unknown) {
  const p = scope
    .extend({
      configuration: guestStageSchema.optional(),
      idempotencyKey: z.string().uuid().optional(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/guest-stage`,
    guestRosterSchema.shape.stage,
    p.data.configuration ? "PUT" : "GET",
    p.data.configuration,
    { broadcastId: p.data.broadcastId },
    p.data.idempotencyKey,
  );
}
export async function guestListAction(input: unknown) {
  const p = scope
    .extend({
      cursor: streamingIdSchema.optional(),
      collection: z.enum(["guests", "invites", "guest-requests"]).default("guests"),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/${p.data.collection}`,
    guestRosterSchema,
    "GET",
    undefined,
    { broadcastId: p.data.broadcastId, ...(p.data.cursor ? { cursor: p.data.cursor } : {}) },
  );
}
export async function guestCommandAction(input: unknown) {
  const p = scope
    .extend({
      action: z.enum([
        "invite",
        "cancelInvite",
        "approveRequest",
        "rejectRequest",
        "mute",
        "remove",
      ]),
      guestId: streamingIdSchema.optional(),
      configuration: z.unknown(),
      idempotencyKey: z.string().uuid(),
    })
    .safeParse(input);
  if (!p.success) return invalid;
  const body = (
    p.data.action === "invite"
      ? inviteGuestSchema
      : p.data.action === "mute"
        ? guestMuteSchema
        : guestDecisionSchema
  ).safeParse(p.data.configuration);
  if (!body.success) return invalid;
  const routes = {
    cancelInvite: "invites",
    approveRequest: "guest-requests",
    rejectRequest: "guest-requests",
    mute: "guests",
    remove: "guests",
  } as const;
  const commands = {
    cancelInvite: "cancel",
    approveRequest: "approve",
    rejectRequest: "reject",
    mute: "mute",
    remove: "remove",
  } as const;
  const path =
    p.data.action === "invite"
      ? "invites"
      : p.data.guestId
        ? `${routes[p.data.action]}/${p.data.guestId}/${commands[p.data.action]}`
        : null;
  if (!path) return invalid;
  return requestStreaming(
    p.data.projectId,
    p.data.environmentId,
    `streams/${p.data.streamId}/${path}`,
    guestResourceSchema,
    "POST",
    body.data,
    { broadcastId: p.data.broadcastId },
    p.data.idempotencyKey,
  );
}
