import type { RoomCapabilities } from "@relayrtc/types";
import { roomCapabilitiesSchema } from "@relayrtc/validation";
import type { Participant, ParticipantSession, RoomId, SessionId, Track } from "@relayrtc/types";
import {
  participantSchema,
  isoDateTimeSchema,
  participantSessionSchema,
  roomIdSchema,
  sessionIdSchema,
  trackSchema,
} from "@relayrtc/validation";
import { z } from "zod";

import type { ProtocolRequest, ProtocolResponse } from "./envelope.js";
import { protocolRequestSchema, protocolResponseSchema } from "./envelope.js";

export interface SessionResumeRequestPayload {
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  readonly resumeToken: string;
}

export interface SessionResumeAcceptedPayload {
  readonly capabilities?: RoomCapabilities | undefined;
  readonly roomId: RoomId;
  readonly session: ParticipantSession;
  readonly participants: readonly Participant[];
  readonly tracks: readonly Track[];
}

export type SessionResumeRequest = ProtocolRequest<"session.resume", SessionResumeRequestPayload>;
export type SessionResumeAcceptedResponse = ProtocolResponse<
  "session.resume.accepted",
  SessionResumeAcceptedPayload
>;

export const sessionResumeRequestSchema = protocolRequestSchema(
  "session.resume",
  z
    .object({
      roomId: roomIdSchema,
      sessionId: sessionIdSchema,
      resumeToken: z.string().min(1).max(8_192),
    })
    .strict(),
) satisfies z.ZodType<SessionResumeRequest>;

export const sessionResumeAcceptedResponseSchema = protocolResponseSchema(
  "session.resume.accepted",
  z
    .object({
      roomId: roomIdSchema,
      session: participantSessionSchema,
      participants: z.array(participantSchema).readonly(),
      tracks: z.array(trackSchema).readonly(),
      capabilities: roomCapabilitiesSchema.optional(),
    })
    .strict(),
) satisfies z.ZodType<SessionResumeAcceptedResponse>;

export interface SessionRefreshPayload {
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  readonly participantToken: string;
}

export interface SessionRefreshAcceptedPayload {
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  readonly expiresAt: string;
}

export type SessionRefreshRequest = ProtocolRequest<"session.refresh", SessionRefreshPayload>;
export type SessionRefreshAcceptedResponse = ProtocolResponse<
  "session.refresh.accepted",
  SessionRefreshAcceptedPayload
>;

export const sessionRefreshRequestSchema = protocolRequestSchema(
  "session.refresh",
  z
    .object({
      roomId: roomIdSchema,
      sessionId: sessionIdSchema,
      participantToken: z.string().min(1).max(8_192),
    })
    .strict(),
) satisfies z.ZodType<SessionRefreshRequest>;

export const sessionRefreshAcceptedResponseSchema = protocolResponseSchema(
  "session.refresh.accepted",
  z
    .object({
      roomId: roomIdSchema,
      sessionId: sessionIdSchema,
      expiresAt: isoDateTimeSchema,
    })
    .strict(),
) satisfies z.ZodType<SessionRefreshAcceptedResponse>;
