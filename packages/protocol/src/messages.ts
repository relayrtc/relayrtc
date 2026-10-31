import { participantAccessGetRequestSchema, participantAccessGetResponseSchema, participantAccessUpdateRequestSchema, participantAccessUpdateResponseSchema, roomCapabilitiesChangedSchema } from "./room-access.js";
import type { ParticipantAccessGetRequest, ParticipantAccessGetResponse, ParticipantAccessUpdateRequest, ParticipantAccessUpdateResponse, RoomCapabilitiesChanged } from "./room-access.js";
import { z } from "zod";
import type {
  RtcSubscriptionQualityRequest,
  RtcSubscriptionQualityAcceptedResponse,
} from "./quality-stats.js";
import {
  rtcSubscriptionQualityRequestSchema,
  rtcSubscriptionQualityAcceptedResponseSchema,
} from "./quality-stats.js";
import type { RtcStatsReportRequest, RtcStatsAcceptedResponse } from "./quality-stats.js";
import { rtcStatsReportRequestSchema, rtcStatsAcceptedResponseSchema } from "./quality-stats.js";
import type { ConnectionQualityChangedEvent } from "./quality.js";
import { connectionQualityChangedEventSchema } from "./quality.js";

import type { ProtocolErrorMessage } from "./error.js";
import { protocolErrorMessageSchema } from "./error.js";
import type { HeartbeatPingRequest, HeartbeatPongResponse } from "./heartbeat.js";
import { heartbeatPingRequestSchema, heartbeatPongResponseSchema } from "./heartbeat.js";
import type {
  CustomEventEmittedResponse,
  CustomEventEmitRequest,
  CustomEventReceivedEvent,
  TextMessageReceivedEvent,
  TextMessageSendRequest,
  TextMessageSentResponse,
} from "./messaging.js";
import {
  customEventEmittedResponseSchema,
  customEventEmitRequestSchema,
  customEventReceivedEventSchema,
  textMessageReceivedEventSchema,
  textMessageSendRequestSchema,
  textMessageSentResponseSchema,
} from "./messaging.js";
import type {
  ParticipantJoinAcceptedResponse,
  ParticipantJoinedEvent,
  ParticipantJoinRequest,
  ParticipantLeaveAcceptedResponse,
  ParticipantLeftEvent,
  ParticipantLeaveRequest,
  ParticipantReconnectedEvent,
  ParticipantMetadataUpdateRequest,
  ParticipantMetadataUpdatedResponse,
  ParticipantMetadataUpdatedEvent,
} from "./participant.js";
import {
  participantJoinAcceptedResponseSchema,
  participantJoinedEventSchema,
  participantJoinRequestSchema,
  participantLeaveAcceptedResponseSchema,
  participantLeftEventSchema,
  participantLeaveRequestSchema,
  participantReconnectedEventSchema,
  participantMetadataUpdateRequestSchema,
  participantMetadataUpdatedResponseSchema,
  participantMetadataUpdatedEventSchema,
} from "./participant.js";
import type { RoomEndedEvent } from "./room.js";
import { roomEndedEventSchema } from "./room.js";
import type { ConnectionDegradedEvent, ConnectionRecoveredEvent } from "./quality.js";
import { connectionDegradedEventSchema, connectionRecoveredEventSchema } from "./quality.js";
import type {
  RtcCapabilitiesGetRequest,
  RtcSubscriptionResumeRequest,
  RtcSubscriptionCloseRequest,
  RtcSubscriptionCloseAcceptedResponse,
  RtcSubscriptionClosedEvent,
  RtcSubscriptionResumedResponse,
  RtcCapabilitiesResponse,
  RtcIceRestartedResponse,
  RtcIceRestartRequest,
  RtcTrackControlledResponse,
  RtcTrackControlRequest,
  RtcTrackPublishedResponse,
  RtcTrackPublishRequest,
  RtcTrackSubscribedResponse,
  RtcTrackSubscribeRequest,
  RtcTransportConnectedResponse,
  RtcTransportConnectRequest,
  RtcTransportCreatedResponse,
  RtcTransportCreateRequest,
} from "./rtc.js";
import {
  rtcCapabilitiesGetRequestSchema,
  rtcCapabilitiesResponseSchema,
  rtcIceRestartedResponseSchema,
  rtcIceRestartRequestSchema,
  rtcTrackControlledResponseSchema,
  rtcTrackControlRequestSchema,
  rtcTrackPublishedResponseSchema,
  rtcTrackPublishRequestSchema,
  rtcTrackSubscribedResponseSchema,
  rtcSubscriptionResumeRequestSchema,
  rtcSubscriptionCloseRequestSchema,
  rtcSubscriptionCloseAcceptedResponseSchema,
  rtcSubscriptionClosedEventSchema,
  rtcSubscriptionResumedResponseSchema,
  rtcTrackSubscribeRequestSchema,
  rtcTransportConnectedResponseSchema,
  rtcTransportConnectRequestSchema,
  rtcTransportCreatedResponseSchema,
  rtcTransportCreateRequestSchema,
} from "./rtc.js";
import type {
  SessionResumeAcceptedResponse,
  SessionResumeRequest,
  SessionRefreshRequest,
  SessionRefreshAcceptedResponse,
} from "./session.js";
import {
  sessionResumeAcceptedResponseSchema,
  sessionResumeRequestSchema,
  sessionRefreshRequestSchema,
  sessionRefreshAcceptedResponseSchema,
} from "./session.js";
import type {
  TrackPausedEvent,
  TrackPublishedEvent,
  TrackResumedEvent,
  TrackUnpublishedEvent,
} from "./track.js";
import {
  trackPausedEventSchema,
  trackPublishedEventSchema,
  trackResumedEventSchema,
  trackUnpublishedEventSchema,
} from "./track.js";

export const protocolRequestTypes = [
  "room.activity.get","participant.activity.update",
  "room.lifecycle.get", "room.lifecycle.update",
  "participant.access.get", "participant.access.update",
  "rtc.subscription.quality",
  "rtc.stats.report",
  "heartbeat.ping",
  "message.send",
  "event.emit",
  "participant.join",
  "participant.leave",
  "participant.metadata.update",
  "rtc.capabilities.get",
  "rtc.transport.create",
  "rtc.transport.connect",
  "rtc.ice.restart",
  "rtc.track.publish",
  "rtc.track.control",
  "rtc.track.subscribe",
  "rtc.subscription.resume",
  "rtc.subscription.close",
  "session.resume",
  "session.refresh",
] as const;

export const protocolResponseTypes = [
  "room.activity","participant.activity.updated",
  "room.lifecycle", "room.lifecycle.updated",
  "participant.access", "participant.access.update.accepted",
  "rtc.subscription.quality.accepted",
  "rtc.stats.accepted",
  "heartbeat.pong",
  "message.sent",
  "event.emitted",
  "participant.join.accepted",
  "participant.leave.accepted",
  "participant.metadata.update.accepted",
  "rtc.capabilities",
  "rtc.transport.created",
  "rtc.transport.connected",
  "rtc.ice.restarted",
  "rtc.track.publish.accepted",
  "rtc.track.control.accepted",
  "rtc.track.subscribe.accepted",
  "rtc.subscription.resumed",
  "rtc.subscription.close.accepted",
  "session.resume.accepted",
  "session.refresh.accepted",
] as const;

export const protocolEventTypes = [
  "room.activity.changed",
  "room.lifecycle.changed",
  "room.capabilities.changed",
  "connection.quality.changed",
  "room.ended",
  "message.received",
  "event.received",
  "participant.joined",
  "participant.left",
  "participant.reconnected",
  "participant.metadata.updated",
  "track.published",
  "track.paused",
  "track.resumed",
  "track.unpublished",
  "rtc.subscription.closed",
  "connection.degraded",
  "connection.recovered",
] as const;

export type ProtocolRequestMessage =
  | RoomActivityGetRequest | ParticipantActivityUpdateRequest
  | RoomLifecycleGetRequest | RoomLifecycleUpdateRequest
  | ParticipantAccessGetRequest | ParticipantAccessUpdateRequest
  | RtcSubscriptionQualityRequest
  | RtcStatsReportRequest
  | HeartbeatPingRequest
  | TextMessageSendRequest
  | CustomEventEmitRequest
  | ParticipantJoinRequest
  | ParticipantLeaveRequest
  | ParticipantMetadataUpdateRequest
  | RtcCapabilitiesGetRequest
  | RtcSubscriptionResumeRequest
  | RtcSubscriptionCloseRequest
  | RtcTransportCreateRequest
  | RtcTransportConnectRequest
  | RtcIceRestartRequest
  | RtcTrackPublishRequest
  | RtcTrackControlRequest
  | RtcTrackSubscribeRequest
  | SessionResumeRequest
  | SessionRefreshRequest;

export type ProtocolResponseMessage =
  | RoomActivityResponse | ParticipantActivityUpdatedResponse
  | RoomLifecycleResponse | RoomLifecycleUpdatedResponse
  | ParticipantAccessGetResponse | ParticipantAccessUpdateResponse
  | RtcSubscriptionQualityAcceptedResponse
  | RtcStatsAcceptedResponse
  | HeartbeatPongResponse
  | TextMessageSentResponse
  | CustomEventEmittedResponse
  | ParticipantJoinAcceptedResponse
  | ParticipantLeaveAcceptedResponse
  | ParticipantMetadataUpdatedResponse
  | RtcCapabilitiesResponse
  | RtcTransportCreatedResponse
  | RtcTransportConnectedResponse
  | RtcIceRestartedResponse
  | RtcTrackPublishedResponse
  | RtcTrackControlledResponse
  | RtcTrackSubscribedResponse
  | RtcSubscriptionResumedResponse
  | RtcSubscriptionCloseAcceptedResponse
  | SessionResumeAcceptedResponse
  | SessionRefreshAcceptedResponse;

export type ProtocolEventMessage =
  | RoomActivityChanged
  | RoomLifecycleChanged
  | RoomCapabilitiesChanged
  | ConnectionQualityChangedEvent
  | RoomEndedEvent
  | TextMessageReceivedEvent
  | CustomEventReceivedEvent
  | ParticipantJoinedEvent
  | ParticipantLeftEvent
  | ParticipantReconnectedEvent
  | ParticipantMetadataUpdatedEvent
  | TrackPublishedEvent
  | TrackPausedEvent
  | TrackResumedEvent
  | TrackUnpublishedEvent
  | RtcSubscriptionClosedEvent
  | ConnectionDegradedEvent
  | ConnectionRecoveredEvent;

export type ClientProtocolMessage = ProtocolRequestMessage;
export type ServerProtocolMessage =
  ProtocolResponseMessage | ProtocolEventMessage | ProtocolErrorMessage;
export type ProtocolMessage = ClientProtocolMessage | ServerProtocolMessage;
export type ProtocolMessageType = ProtocolMessage["type"];
export type ProtocolMessageOfType<Type extends ProtocolMessageType> = Extract<
  ProtocolMessage,
  { readonly type: Type }
>;

export const protocolMessageTypes = [
  ...protocolRequestTypes,
  ...protocolResponseTypes,
  ...protocolEventTypes,
  "protocol.error",
] as const satisfies readonly ProtocolMessageType[];

export const protocolMessageSchema: z.ZodType<ProtocolMessage> = z.discriminatedUnion("type", [
  roomActivityGetRequestSchema,participantActivityUpdateRequestSchema,roomActivityResponseSchema,participantActivityUpdatedResponseSchema,roomActivityChangedSchema,
  roomLifecycleGetRequestSchema,roomLifecycleUpdateRequestSchema,roomLifecycleResponseSchema,roomLifecycleUpdatedResponseSchema,roomLifecycleChangedSchema,
  participantAccessGetRequestSchema, participantAccessGetResponseSchema, participantAccessUpdateRequestSchema, participantAccessUpdateResponseSchema, roomCapabilitiesChangedSchema,
  rtcSubscriptionQualityRequestSchema,
  rtcSubscriptionQualityAcceptedResponseSchema,
  rtcStatsReportRequestSchema,
  rtcStatsAcceptedResponseSchema,
  connectionQualityChangedEventSchema,
  sessionRefreshRequestSchema,
  sessionRefreshAcceptedResponseSchema,
  heartbeatPingRequestSchema,
  heartbeatPongResponseSchema,
  textMessageSendRequestSchema,
  textMessageSentResponseSchema,
  textMessageReceivedEventSchema,
  customEventEmitRequestSchema,
  customEventEmittedResponseSchema,
  customEventReceivedEventSchema,
  participantJoinRequestSchema,
  participantJoinAcceptedResponseSchema,
  participantLeaveRequestSchema,
  participantLeaveAcceptedResponseSchema,
  participantMetadataUpdateRequestSchema,
  participantMetadataUpdatedResponseSchema,
  participantMetadataUpdatedEventSchema,
  rtcCapabilitiesGetRequestSchema,
  rtcCapabilitiesResponseSchema,
  rtcTransportCreateRequestSchema,
  rtcTransportCreatedResponseSchema,
  rtcTransportConnectRequestSchema,
  rtcTransportConnectedResponseSchema,
  rtcIceRestartRequestSchema,
  rtcIceRestartedResponseSchema,
  rtcTrackPublishRequestSchema,
  rtcTrackPublishedResponseSchema,
  rtcTrackControlRequestSchema,
  rtcTrackControlledResponseSchema,
  rtcTrackSubscribeRequestSchema,
  rtcTrackSubscribedResponseSchema,
  rtcSubscriptionResumeRequestSchema,
  rtcSubscriptionCloseRequestSchema,
  rtcSubscriptionCloseAcceptedResponseSchema,
  rtcSubscriptionClosedEventSchema,
  rtcSubscriptionResumedResponseSchema,
  sessionResumeRequestSchema,
  sessionResumeAcceptedResponseSchema,
  roomEndedEventSchema,
  participantJoinedEventSchema,
  participantLeftEventSchema,
  participantReconnectedEventSchema,
  trackPublishedEventSchema,
  trackPausedEventSchema,
  trackResumedEventSchema,
  trackUnpublishedEventSchema,
  connectionDegradedEventSchema,
  connectionRecoveredEventSchema,
  protocolErrorMessageSchema,
]);

export function parseProtocolMessage(input: unknown): ProtocolMessage {
  return protocolMessageSchema.parse(input);
}

export function safeParseProtocolMessage(input: unknown) {
  return protocolMessageSchema.safeParse(input);
}

export function serializeProtocolMessage(message: ProtocolMessage): string {
  return JSON.stringify(message);
}

export function deserializeProtocolMessage(serialized: string): ProtocolMessage {
  const input: unknown = JSON.parse(serialized);
  return parseProtocolMessage(input);
}
import { roomLifecycleGetRequestSchema,roomLifecycleUpdateRequestSchema,roomLifecycleResponseSchema,roomLifecycleUpdatedResponseSchema,roomLifecycleChangedSchema } from "./room-lifecycle.js";
import type { RoomLifecycleGetRequest,RoomLifecycleUpdateRequest,RoomLifecycleResponse,RoomLifecycleUpdatedResponse,RoomLifecycleChanged } from "./room-lifecycle.js";
import {roomActivityGetRequestSchema,participantActivityUpdateRequestSchema,roomActivityResponseSchema,participantActivityUpdatedResponseSchema,roomActivityChangedSchema} from "./room-activity.js";
import type {RoomActivityGetRequest,ParticipantActivityUpdateRequest,RoomActivityResponse,ParticipantActivityUpdatedResponse,RoomActivityChanged} from "./room-activity.js";
