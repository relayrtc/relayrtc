import { z } from "zod";
import { streamingIdSchema } from "./streaming.js";
export const guestMediaSchema = z
  .object({
    audio: z.boolean().default(true),
    video: z.boolean().default(false),
    screen: z.boolean().default(false),
  })
  .strict();
export const guestDelegations = ["invite", "approve", "moderate"] as const;
export const guestStageSchema = z
  .object({
    enabled: z.boolean(),
    maxGuests: z.number().int().min(1).max(3).default(3),
    version: z.number().int().nonnegative(),
    layout: z.enum(["grid", "single", "pip"]).default("grid"),
  })
  .strict();
export const audienceGrantSchema = z
  .object({
    subject: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(80),
    role: z.enum(["host", "cohost", "moderator", "guest", "viewer"]).default("viewer"),
    delegations: z.array(z.enum(guestDelegations)).max(3).default([]),
    ttlSeconds: z.number().int().min(60).max(3600).default(300),
  })
  .strict();
export const inviteGuestSchema = z
  .object({
    recipientSubject: z.string().min(1).max(128),
    media: guestMediaSchema,
    ttlSeconds: z.number().int().min(30).max(3600).default(300),
  })
  .strict();
export const guestDecisionSchema = z
  .object({ version: z.number().int().positive(), subject: z.string().min(1).max(128).optional() })
  .strict();
export const guestRequestSchema = z
  .object({ subject: z.string().min(1).max(128).optional(), media: guestMediaSchema })
  .strict();
export const guestMuteSchema = guestDecisionSchema
  .extend({ audio: z.boolean().optional(), video: z.boolean().optional() })
  .strict()
  .refine(
    (v) => v.audio !== undefined || v.video !== undefined,
    "Select audio or video moderation.",
  );
export const guestQuerySchema = z
  .object({
    subject: z.string().min(1).max(128).optional(),
    projectId: z.string().optional(),
    environmentId: z.string().optional(),
    broadcastId: streamingIdSchema,
    cursor: streamingIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
export const guestResourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["invite", "request"]),
  state: z.enum([
    "pending",
    "accepted",
    "declined",
    "approved",
    "rejected",
    "cancelled",
    "expired",
    "joined",
    "left",
    "removed",
  ]),
  version: z.number(),
  name: z.string(),
  media: guestMediaSchema,
  mutedAudio: z.boolean(),
  mutedVideo: z.boolean(),
  participantId: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  subject: z.string().optional(),
  actorId: z.string().optional(),
});
export const guestRosterSchema = z.object({
  data: z.array(guestResourceSchema),
  nextCursor: z.string().nullable(),
  stage: z.object({
    enabled: z.boolean(),
    version: z.number(),
    maxGuests: z.number(),
    occupied: z.number(),
    layout: z.enum(["single", "grid", "pip"]),
    roomId: z.string(),
  }),
});
export const guestJoinGrantSchema = z.object({
  token: z.string(),
  participantId: z.string(),
  roomId: z.string(),
  expiresAt: z.string(),
  version: z.number(),
  media: guestMediaSchema,
  signalingUrl: z.string(),
});
