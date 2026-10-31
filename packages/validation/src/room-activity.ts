import { z } from "zod";
import { participantActivityStates } from "@relayrtc/types";
import { roomIdSchema, participantIdSchema, isoDateTimeSchema } from "./common.js";

export const roomActivityPolicySchema = z
  .object({
    version: z.number().int().min(1).max(2_147_483_646),
    activityEnabled: z.boolean(),
    speakersEnabled: z.boolean(),
    idleSeconds: z.number().int().min(30).max(3600),
    heartbeatSeconds: z.number().int().min(30).max(120),
  })
  .strict();
export const participantActivityPreferencesSchema = z
  .object({
    mode: z.enum(["auto", "away"]),
    shareActivity: z.boolean(),
    shareSpeaking: z.boolean(),
  })
  .strict();
export const roomActivitySnapshotSchema = z
  .object({
    roomId: roomIdSchema,
    observedAt: isoDateTimeSchema,
    policy: roomActivityPolicySchema,
    participants: z
      .array(
        z
          .object({ participantId: participantIdSchema, state: z.enum(participantActivityStates) })
          .strict(),
      )
      .max(512),
    truncated: z.boolean(),
    speakers: z
      .array(
        z.object({ participantId: participantIdSchema, level: z.number().min(0).max(1) }).strict(),
      )
      .max(16),
    dominantSpeakerId: participantIdSchema.nullable(),
    speakerState: z.enum(["available", "unavailable", "disabled"]),
  })
  .strict();
