import { metadataSchema, nameSchema, sessionIdSchema } from "@relayrtc/validation";
import { z } from "zod";

export const participantPermissions = [
  "room:join",
  "audio:publish",
  "video:publish",
  "screen:publish",
  "messages:send",
  "metadata:update",
] as const;

export const participantPermissionSchema = z.enum(participantPermissions);

const permissionsSchema = z
  .array(participantPermissionSchema)
  .min(1)
  .max(participantPermissions.length)
  .refine((permissions) => new Set(permissions).size === permissions.length, {
    message: "Participant permissions must be unique",
  })
  .refine((permissions) => permissions.includes("room:join"), {
    message: "Participant permissions must include room:join",
  });

export const createParticipantTokenBodySchema = z
  .object({
    participantName: nameSchema,
    permissions: permissionsSchema.default(["room:join"]),
    metadata: metadataSchema.default({}),
    ttlSeconds: z.number().int().min(60).max(3_600).default(600),
  })
  .strict();

export type CreateParticipantTokenBody = z.infer<typeof createParticipantTokenBodySchema>;
export type ParticipantPermission = z.infer<typeof participantPermissionSchema>;

export const renewParticipantTokenBodySchema = z
  .object({
    participantToken: z.string().min(1).max(8192),
    sessionId: sessionIdSchema,
    ttlSeconds: z.number().int().min(60).max(3_600).default(600),
  })
  .strict();

export type RenewParticipantTokenBody = z.infer<typeof renewParticipantTokenBodySchema>;
