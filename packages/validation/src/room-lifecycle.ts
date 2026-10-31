import { z } from "zod";
import { roomParticipantPermissions } from "@relayrtc/types";
import { roomIdSchema, isoDateTimeSchema } from "./common.js";

export const updateRoomLifecycleSchema = z
  .object({
    version: z.number().int().min(1).max(2_147_483_646),
    locked: z.boolean(),
    endsAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export const roomLifecycleSchema = updateRoomLifecycleSchema.extend({
  roomId: roomIdSchema,
  warning: z.boolean(),
  serverTime: isoDateTimeSchema,
});

export const createRoomInvitationSchema = z
  .object({
    expiresAt: isoDateTimeSchema,
    maxUses: z.number().int().min(1).max(100),
    identity: z.string().trim().min(1).max(200).nullable(),
    permissions: z
      .array(z.enum(roomParticipantPermissions))
      .min(1)
      .max(6)
      .refine(
        (values) => new Set(values).size === values.length && values.includes("room:join"),
        "Include room:join and unique permissions",
      ),
  })
  .strict();

export const redeemRoomInvitationSchema = z
  .object({
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    redemptionId: z.uuid(),
    identity: z.string().trim().min(1).max(200),
    participantName: z.string().trim().min(1).max(120),
  })
  .strict();

export const roomInvitationSchema = createRoomInvitationSchema.extend({
  id: z.string().regex(/^rinv_[a-f0-9]{32}$/),
  roomId: roomIdSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  uses: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
});
