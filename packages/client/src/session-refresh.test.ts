import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRefresh } from "./session-refresh.js";
import { RoomError } from "./room-errors.js";
import type { SignalingClient } from "./signaling-client.js";
import type { RoomRtc } from "./room-rtc.js";
import type { ParticipantJoinAcceptedPayload } from "@relayrtc/protocol";

const initial = Date.parse("2026-10-22T12:00:00Z");
const token = (expires: number, participantId = "participant_test") => {
  const claims = {
    roomId: "room_test",
    participantId,
    projectId: "project_test",
    environmentId: "env_test",
    permissions: ["room:join"],
    exp: Math.floor(expires / 1000),
  };
  return `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(claims)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.signature`;
};
const scope = {
  room: { id: "room_test" },
  localParticipant: { id: "participant_test" },
  session: { id: "session_test" },
} as ParticipantJoinAcceptedPayload;
function fixture(provider: () => Promise<string | null>) {
  vi.useFakeTimers();
  vi.setSystemTime(initial);
  const failure = vi.fn();
  const refreshed = vi.fn();
  const request = vi.fn((_type: string, input: { participantToken: string }) => {
    const claims = JSON.parse(atob(input.participantToken.split(".")[1] ?? "")) as { exp: number };
    return Promise.resolve({
      roomId: "room_test",
      sessionId: "session_test",
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    });
  });
  const refresh = new SessionRefresh(
    { signalingUrl: "ws://example.test", refreshToken: provider },
    { request } as unknown as SignalingClient,
    {} as RoomRtc,
    failure,
    refreshed,
  );
  return { refresh, failure, refreshed, request };
}
afterEach(() => vi.useRealTimers());
describe("identity-preserving participant renewal", () => {
  it("defers temporary in-flight renewal failure during recovery and retries after resume", async () => {
    let rejectRenewal: (error: Error) => void = () => undefined;
    const provider = vi
      .fn<() => Promise<string | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRenewal = reject;
          }),
      )
      .mockImplementation(() => Promise.resolve(token(Date.now() + 60000)));
    const f = fixture(provider);
    await f.refresh.prepare(token(initial + 60000), scope);
    f.refresh.start();
    await vi.advanceTimersByTimeAsync(30000);
    f.refresh.pause();
    rejectRenewal(new RoomError("TOKEN_REFRESH_FAILED", "offline", true));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.failure).not.toHaveBeenCalled();
    await f.refresh.resumed();
    await vi.advanceTimersByTimeAsync(15000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(f.failure).not.toHaveBeenCalled();
    f.refresh.dispose();
  });
  it("renews across several original expiry boundaries and uses the newest token for resume", async () => {
    const provider = vi.fn(() => Promise.resolve(token(Date.now() + 60000)));
    const f = fixture(provider);
    await f.refresh.prepare(token(initial + 60000), scope);
    f.refresh.start();
    await vi.advanceTimersByTimeAsync(125000);
    expect(provider).toHaveBeenCalledTimes(4);
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledWith(
      "session.refresh",
      expect.objectContaining({ sessionId: "session_test" }),
      "session.refresh.accepted",
    );
    expect(await f.refresh.resumeToken()).toBe(token(initial + 180000));
    expect(f.refreshed).toHaveBeenCalledTimes(4);
    f.refresh.dispose();
  });
  it("retries temporary callback failures while the original token remains valid", async () => {
    const provider = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new RoomError("TOKEN_REFRESH_FAILED", "temporary", true))
      .mockImplementation(() => Promise.resolve(token(Date.now() + 60000)));
    const f = fixture(provider);
    await f.refresh.prepare(token(initial + 60000), scope);
    f.refresh.start();
    await vi.advanceTimersByTimeAsync(32000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.refreshed).toHaveBeenCalledOnce();
    f.refresh.dispose();
  });
  it("fails closed for revocation or changed participant identity", async () => {
    for (const value of [null, token(initial + 90000, "participant_other")]) {
      const f = fixture(() => Promise.resolve(value));
      await f.refresh.prepare(token(initial + 60000), scope);
      f.refresh.start();
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.failure).toHaveBeenCalledWith(
        expect.objectContaining({ code: "CREDENTIALS_REVOKED" }),
      );
      expect(f.request).not.toHaveBeenCalled();
      f.refresh.dispose();
    }
  });
  it("does not retry beyond expiry or keep timers after dispose", async () => {
    const f = fixture(() =>
      Promise.reject(new RoomError("TOKEN_REFRESH_FAILED", "temporary", true)),
    );
    await f.refresh.prepare(token(initial + 60000), scope);
    f.refresh.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ code: "TOKEN_EXPIRED" }));
    f.refresh.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
