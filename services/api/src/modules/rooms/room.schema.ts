import { metadataSchema, nameSchema, roomIdSchema, roomStatusSchema } from "@relayrtc/validation";
import { z } from "zod";

export const createRoomBodySchema = z
  .object({
    name: nameSchema,
    metadata: metadataSchema.default({}),
    maxParticipants: z.number().int().positive().max(100_000).default(100),
  })
  .strict();

export const listRoomsQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: roomStatusSchema.optional(),
    search: z.string().trim().max(120).optional(),
    joinable: z.enum(["true", "false"]).transform(value => value === "true").optional(),
  })
  .strict();

export const roomParamsSchema = z
  .object({
    roomId: roomIdSchema,
  })
  .strict();

export type CreateRoomBody = z.infer<typeof createRoomBodySchema>;
export type ListRoomsQuery = z.infer<typeof listRoomsQuerySchema>;
