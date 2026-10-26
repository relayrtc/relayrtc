import { describe, expect, expectTypeOf, it } from "vitest";

import {
  deserializeProtocolMessage,
  parseProtocolMessage,
  protocolEventTypes,
  protocolMessageTypes,
  protocolRequestTypes,
  protocolResponseTypes,
  safeParseProtocolMessage,
  serializeProtocolMessage,
  type ProtocolMessageOfType,
} from "./messages.js";
import {
  participant,
  request,
  response,
  room,
  session,
  timestamp,
  track,
} from "./protocol.fixture.js";
import { PROTOCOL_VERSION } from "./version.js";

describe("protocol envelope", () => {
  it("parses and narrows a v1 request", () => {
    const message = parseProtocolMessage(request("heartbeat.ping", { nonce: "heartbeat_123" }));

    expect(PROTOCOL_VERSION).toBe(1);
    expect(message.type).toBe("heartbeat.ping");
    if (message.type === "heartbeat.ping") {
      expect(message.payload.nonce).toBe("heartbeat_123");
    }
  });

  it("correlates responses to requests", () => {
    const result = safeParseProtocolMessage(
      response("heartbeat.pong", {
        nonce: "heartbeat_123",
        serverTime: timestamp,
      }),
    );

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "heartbeat.pong") {
      expect(result.data.requestId).toBe("request_123");
    }
  });

  it("rejects unsupported versions and message types", () => {
    expect(
      safeParseProtocolMessage({
        ...request("heartbeat.ping", { nonce: "heartbeat_123" }),
        v: 2,
      }).success,
    ).toBe(false);
    expect(safeParseProtocolMessage(request("unknown.message", {})).success).toBe(false);
  });

  it("rejects unknown envelope and payload properties", () => {
    expect(
      safeParseProtocolMessage({
        ...request("heartbeat.ping", { nonce: "heartbeat_123" }),
        internal: true,
      }).success,
    ).toBe(false);
    expect(
      safeParseProtocolMessage(request("heartbeat.ping", { nonce: "heartbeat_123", extra: true }))
        .success,
    ).toBe(false);
  });

  it("serializes and deserializes validated messages", () => {
    const message = parseProtocolMessage(
      request("participant.join", {
        roomId: "room_123",
        participantToken: "participant-token",
      }),
    );
    const serialized = serializeProtocolMessage(message);
    const restored = deserializeProtocolMessage(serialized);

    expect(restored).toEqual(message);
  });

  it("exports exhaustive category literals", () => {
    expect(protocolRequestTypes).toEqual([
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
    ]);
    expect(protocolResponseTypes).toHaveLength(19);
    expect(protocolEventTypes).toHaveLength(15);
    expect(protocolMessageTypes).toHaveLength(54);
    expectTypeOf<ProtocolMessageOfType<"participant.join">["payload"]>().toHaveProperty(
      "participantToken",
    );
  });

  it("validates credential refresh without accepting identity or permission overrides", () => {
    const payload = {
      roomId: "room_123",
      sessionId: "session_123",
      participantToken: "replacement-token",
    };
    expect(safeParseProtocolMessage(request("session.refresh", payload)).success).toBe(true);
    expect(
      safeParseProtocolMessage(request("session.refresh", { ...payload, participantToken: "" }))
        .success,
    ).toBe(false);
    expect(
      safeParseProtocolMessage(
        request("session.refresh", { ...payload, permissions: ["room:join"] }),
      ).success,
    ).toBe(false);
    expect(
      safeParseProtocolMessage(
        request("session.refresh", { ...payload, participantId: "different-participant" }),
      ).success,
    ).toBe(false);
  });
});

describe("participant and session requests", () => {
  it("parses participant join and leave flows", () => {
    const joinRequest = request("participant.join", {
      roomId: "room_123",
      participantToken: "participant-token",
    });
    const joinResponse = response("participant.join.accepted", {
      room,
      localParticipant: participant,
      session,
      participants: [participant],
      tracks: [track],
    });
    const leaveRequest = request("participant.leave", {
      roomId: "room_123",
      participantId: "participant_123",
      sessionId: "session_123",
    });
    const leaveResponse = response("participant.leave.accepted", {
      roomId: "room_123",
      participantId: "participant_123",
      sessionId: "session_123",
      leftAt: timestamp,
    });

    expect(safeParseProtocolMessage(joinRequest).success).toBe(true);
    expect(safeParseProtocolMessage(joinResponse).success).toBe(true);
    expect(safeParseProtocolMessage(leaveRequest).success).toBe(true);
    expect(safeParseProtocolMessage(leaveResponse).success).toBe(true);
  });

  it("parses session resume flows", () => {
    const resumeRequest = request("session.resume", {
      roomId: "room_123",
      sessionId: "session_123",
      resumeToken: "resume-token",
    });
    const resumeResponse = response("session.resume.accepted", {
      roomId: "room_123",
      session,
      participants: [participant],
      tracks: [track],
    });

    expect(safeParseProtocolMessage(resumeRequest).success).toBe(true);
    expect(safeParseProtocolMessage(resumeResponse).success).toBe(true);
  });

  it("rejects missing and empty credentials", () => {
    expect(
      safeParseProtocolMessage(
        request("participant.join", { roomId: "room_123", participantToken: "" }),
      ).success,
    ).toBe(false);
    expect(
      safeParseProtocolMessage(
        request("session.resume", { roomId: "room_123", sessionId: "session_123" }),
      ).success,
    ).toBe(false);
  });
});
