import { z } from "zod";
import {
  roomIdSchema,
  sessionIdSchema,
  roomActivitySnapshotSchema,
  participantActivityPreferencesSchema,
} from "@relayrtc/validation";
import { protocolRequestSchema, protocolResponseSchema, protocolEventSchema } from "./envelope.js";
const target = z.object({ roomId: roomIdSchema, sessionId: sessionIdSchema }).strict();
export const roomActivityGetRequestSchema = protocolRequestSchema("room.activity.get", target);
export const participantActivityUpdateRequestSchema = protocolRequestSchema(
  "participant.activity.update",
  target
    .extend(participantActivityPreferencesSchema.shape)
    .extend({ visible: z.boolean(), active: z.boolean() }),
);
export const roomActivityResponseSchema = protocolResponseSchema(
  "room.activity",
  roomActivitySnapshotSchema,
);
export const participantActivityUpdatedResponseSchema = protocolResponseSchema(
  "participant.activity.updated",
  participantActivityPreferencesSchema,
);
export const roomActivityChangedSchema = protocolEventSchema(
  "room.activity.changed",
  roomActivitySnapshotSchema,
);
export type RoomActivityGetRequest = z.infer<typeof roomActivityGetRequestSchema>;
export type ParticipantActivityUpdateRequest = z.infer<
  typeof participantActivityUpdateRequestSchema
>;
export type RoomActivityResponse = z.infer<typeof roomActivityResponseSchema>;
export type ParticipantActivityUpdatedResponse = z.infer<
  typeof participantActivityUpdatedResponseSchema
>;
export type RoomActivityChanged = z.infer<typeof roomActivityChangedSchema>;
