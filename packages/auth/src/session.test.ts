import { describe, expect, it } from "vitest";

import {
  relayKitSessionPolicy,
  sessionCookieAttributes,
  sessionExpiresInSeconds,
  sessionFreshAgeSeconds,
  sessionUpdateAgeSeconds,
} from "./session.js";

describe("session policy", () => {
  it("uses a seven-day rolling lifetime with daily refresh", () => {
    expect(sessionExpiresInSeconds).toBe(604_800);
    expect(sessionUpdateAgeSeconds).toBe(86_400);
    expect(sessionFreshAgeSeconds).toBe(0);
    expect(relayKitSessionPolicy).toEqual({
      cookieCache: { enabled: false },
      deferSessionRefresh: true,
      expiresIn: 604_800,
      freshAge: 0,
      storeSessionInDatabase: true,
      updateAge: 86_400,
    });
  });

  it.each([
    ["http://localhost:3001", false],
    ["https://dashboard.relayrtc.example", true],
  ])("sets secure cookies appropriately for %s", (baseUrl, secure) => {
    expect(sessionCookieAttributes(baseUrl)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure,
    });
  });
});
