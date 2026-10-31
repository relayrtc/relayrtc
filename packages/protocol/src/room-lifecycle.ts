import { z } from "zod";
import {
  roomIdSchema,
  sessionIdSchema,
  roomLifecycleSchema,
  updateRoomLifecycleSchema,
} from "@relayrtc/validation";
import { protocolRequestSchema, protocolResponseSchema, protocolEventSchema } from "./envelope.js";

const target = z.object({ roomId: roomIdSchema, sessionId: sessionIdSchema }).strict();
export const roomLifecycleGetRequestSchema = protocolRequestSchema("room.lifecycle.get", target);
export const roomLifecycleUpdateRequestSchema = protocolRequestSchema(
  "room.lifecycle.update",
  target.extend(updateRoomLifecycleSchema.shape),
);
export const roomLifecycleResponseSchema = protocolResponseSchema(
  "room.lifecycle",
  roomLifecycleSchema,
);
export const roomLifecycleUpdatedResponseSchema = protocolResponseSchema(
  "room.lifecycle.updated",
  roomLifecycleSchema,
);
export const roomLifecycleChangedSchema = protocolEventSchema(
  "room.lifecycle.changed",
  roomLifecycleSchema,
);
export type RoomLifecycleGetRequest = z.infer<typeof roomLifecycleGetRequestSchema>;
export type RoomLifecycleUpdateRequest = z.infer<typeof roomLifecycleUpdateRequestSchema>;
export type RoomLifecycleResponse = z.infer<typeof roomLifecycleResponseSchema>;
export type RoomLifecycleUpdatedResponse = z.infer<typeof roomLifecycleUpdatedResponseSchema>;
export type RoomLifecycleChanged = z.infer<typeof roomLifecycleChangedSchema>;
