import {
  participantAccessSchema,
  roomCapabilitiesSchema,
  updateParticipantAccessSchema,
  participantIdSchema,
  roomIdSchema,
  sessionIdSchema,
} from "@relayrtc/validation";
import { z } from "zod";
import { protocolRequestSchema, protocolResponseSchema, protocolEventSchema } from "./envelope.js";

const target = z
  .object({ roomId: roomIdSchema, sessionId: sessionIdSchema, participantId: participantIdSchema })
  .strict();
export const participantAccessGetRequestSchema = protocolRequestSchema(
  "participant.access.get",
  target,
);
export const participantAccessGetResponseSchema = protocolResponseSchema(
  "participant.access",
  z.object({ access: participantAccessSchema }).strict(),
);
export const participantAccessUpdateRequestSchema = protocolRequestSchema(
  "participant.access.update",
  target.extend(updateParticipantAccessSchema.shape),
);
export const participantAccessUpdateResponseSchema = protocolResponseSchema(
  "participant.access.update.accepted",
  z.object({ access: participantAccessSchema }).strict(),
);
export const roomCapabilitiesChangedSchema = protocolEventSchema(
  "room.capabilities.changed",
  roomCapabilitiesSchema,
);
export type ParticipantAccessGetRequest = z.infer<typeof participantAccessGetRequestSchema>;
export type ParticipantAccessGetResponse = z.infer<typeof participantAccessGetResponseSchema>;
export type ParticipantAccessUpdateRequest = z.infer<typeof participantAccessUpdateRequestSchema>;
export type ParticipantAccessUpdateResponse = z.infer<typeof participantAccessUpdateResponseSchema>;
export type RoomCapabilitiesChanged = z.infer<typeof roomCapabilitiesChangedSchema>;
