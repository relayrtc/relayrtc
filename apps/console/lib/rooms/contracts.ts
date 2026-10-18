import { z } from "zod";
import {
  environmentIdSchema,
  metadataSchema,
  nameSchema,
  projectIdSchema,
  roomIdSchema,
  roomSchema,
  roomStatusSchema,
} from "@relayrtc/validation";

export const roomScopeSchema = z.object({
  projectId: projectIdSchema,
  environmentId: environmentIdSchema,
});
export const roomConfigurationSchema = z
  .object({
    name: nameSchema,
    maxParticipants: z.number().int().positive().max(100_000).default(100),
    metadata: metadataSchema.default({}),
  })
  .strict();
export const createConsoleRoomSchema = roomScopeSchema.extend({
  configuration: roomConfigurationSchema,
  requestId: z.string().uuid(),
});
export const listConsoleRoomsSchema = roomScopeSchema.extend({
  cursor: z.object({ createdAt: z.iso.datetime({ offset: true }), id: roomIdSchema }).optional(),
  status: roomStatusSchema.optional(),
});
export const getConsoleRoomSchema = roomScopeSchema.extend({ roomId: roomIdSchema });
export type ConsoleRoom = z.infer<typeof roomSchema>;
export type RoomListCursor = NonNullable<z.infer<typeof listConsoleRoomsSchema>["cursor"]>;
export type ConsoleRoomPage = { rooms: ConsoleRoom[]; nextCursor: RoomListCursor | null };
export type RoomResult<T> =
  { data: T; error: null } | { data: null; error: { description: string } };
