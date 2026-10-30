import { roomParticipantPermissions, roomRoles } from "@relayrtc/types";
import { z } from "zod";
import { participantIdSchema, roomIdSchema } from "./common.js";

export const roomRoleSchema = z.enum(roomRoles);
export const roomParticipantPermissionSchema = z.enum(roomParticipantPermissions);
const permissions = z
  .array(roomParticipantPermissionSchema)
  .max(roomParticipantPermissions.length)
  .refine((values) => new Set(values).size === values.length, "Permissions must be unique")
  .readonly();
export const updateParticipantAccessSchema = z
  .object({
    version: z.number().int().positive().max(2_147_483_646),
    role: roomRoleSchema,
    allowedPermissions: permissions
      .nullable()
      .refine(
        (values) => values === null || values.includes("room:join"),
        "Use participant removal to revoke admission",
      ),
  })
  .strict();
export const participantAccessSchema = z
  .object({
    roomId: roomIdSchema,
    participantId: participantIdSchema,
    role: roomRoleSchema,
    version: z.number().int().positive(),
    allowedPermissions: permissions.nullable(),
  })
  .strict();
export const roomCapabilitiesSchema = z
  .object({
    roomId: roomIdSchema,
    participantId: participantIdSchema,
    role: roomRoleSchema,
    version: z.number().int().positive(),
    permissions,
    canManageRoles: z.boolean(),
    canManagePermissions: z.boolean(),
  })
  .strict();
export const roomAuditQuerySchema = z
  .object({
    before: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(160).optional(),
    actorId: z.string().min(1).max(128).optional(),
    participantId: participantIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (value) => Boolean(value.before) === Boolean(value.cursor),
    "Provide both before and cursor",
  );
