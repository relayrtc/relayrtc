import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import type { RelayKitDatabase } from "@relayrtc/database";
import {
  createParticipantTokenSigner,
  type ParticipantTokenClaims,
} from "./participant-token.signer.js";
import { createParticipantTokenVerifier } from "./participant-token.verifier.js";
import { createParticipantTokenRenewalService } from "./participant-token-renewal.service.js";
import { createActiveRenewalSession } from "./participant-token-renewal.repository.js";
import { renewParticipantTokenBodySchema } from "./participant-token.schema.js";

const config = {
  secret: "a-secure-participant-token-secret-123",
  audience: "relayrtc-realtime",
  issuer: "relayrtc-api",
  keyId: "participant-v1",
};
const initial = new Date("2026-10-22T12:00:00Z");
const scope = { projectId: "project_test", environmentId: "env_test" };
const original: ParticipantTokenClaims = {
  ...scope,
  roomId: "room_test",
  participantId: "participant_test",
  participantName: "Ada",
  metadata: { role: "speaker" },
  permissions: ["room:join", "audio:publish"],
  tokenId: "ptok_original",
  issuedAt: initial.toISOString(),
  expiresAt: new Date(+initial + 60000).toISOString(),
};
const signer = createParticipantTokenSigner(config);
const verifier = createParticipantTokenVerifier(config);
const sessionId = renewParticipantTokenBodySchema.shape.sessionId.parse("session_test");
const active = async <T>(_scope: unknown, action: () => Promise<T>) => action();

describe("participant token renewal", () => {
  it("renews repeatedly past the original lifetime, preserving identity and grant", async () => {
    let now = new Date(+initial + 30000);
    let id = 0;
    const checkedSession = vi.fn();
    const service = createParticipantTokenRenewalService({
      signer,
      verifier,
      clock: () => now,
      createId: () => String(++id),
      withActiveSession: async (session, action) => {
        checkedSession(session);
        return action();
      },
    });
    let token = await signer.sign(original);
    for (let index = 0; index < 6; index++) {
      const result = await service.renew(scope, original.roomId, {
        participantToken: token,
        sessionId,
        ttlSeconds: 60,
      });
      const claims = await verifier.verify(result.token, now);
      expect(claims).toMatchObject({
        ...scope,
        roomId: original.roomId,
        participantId: original.participantId,
        permissions: original.permissions,
        metadata: original.metadata,
        participantName: original.participantName,
      });
      expect(result.tokenId).not.toBe(original.tokenId);
      expect(Date.parse(result.expiresAt)).toBe(+now + 60000);
      token = result.token;
      now = new Date(+now + 30000);
    }
    expect(checkedSession).toHaveBeenCalledWith({
      ...scope,
      roomId: "room_test",
      participantId: "participant_test",
      sessionId,
    });
  });
  it("rejects expired tokens, scope changes, guest identities and non-extending expiration", async () => {
    let now = new Date(+initial + 30000);
    const service = createParticipantTokenRenewalService({
      signer,
      verifier,
      clock: () => now,
      withActiveSession: active,
    });
    const input = { participantToken: await signer.sign(original), sessionId, ttlSeconds: 60 };
    await expect(
      service.renew({ ...scope, environmentId: "other" }, "room_test", input),
    ).rejects.toMatchObject({ code: "TOKEN_SCOPE_MISMATCH" });
    await expect(service.renew(scope, "other", input)).rejects.toMatchObject({
      code: "TOKEN_SCOPE_MISMATCH",
    });
    await expect(
      service.renew(scope, "room_test", {
        ...input,
        participantToken: await signer.sign({ ...original, participantId: "guestp_test" }),
      }),
    ).rejects.toMatchObject({ code: "GUEST_TOKEN_RENEWAL_REQUIRED" });
    now = initial;
    await expect(service.renew(scope, "room_test", input)).rejects.toMatchObject({
      code: "TOKEN_EXPIRATION_NOT_EXTENDED",
    });
    now = new Date(+initial + 60000);
    await expect(service.renew(scope, "room_test", input)).rejects.toMatchObject({
      code: "INVALID_PARTICIPANT_TOKEN",
    });
  });
  it("cannot sign when session eligibility fails (removed/left/ended/inactive/wrong session)", async () => {
    const sign = vi.fn((claims: ParticipantTokenClaims) => signer.sign(claims));
    const service = createParticipantTokenRenewalService({
      signer: { sign },
      verifier,
      clock: () => new Date(+initial + 30000),
      withActiveSession: () => Promise.reject(new Error("not active")),
    });
    await expect(
      service.renew(scope, "room_test", {
        participantToken: await signer.sign(original),
        sessionId,
        ttlSeconds: 60,
      }),
    ).rejects.toThrow("not active");
    expect(sign).not.toHaveBeenCalled();
  });
  it("locks database scope/session checks around signing and refuses absent eligible rows", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const transaction = vi.fn(async (action: (tx: unknown) => Promise<unknown>) =>
      action({ execute }),
    );
    const withActiveSession = createActiveRenewalSession({
      transaction,
    } as unknown as RelayKitDatabase);
    const action = vi.fn(() => Promise.resolve("signed"));
    const session = {
      ...scope,
      roomId: "room_test",
      participantId: "participant_test",
      sessionId: "session_test",
    };
    await expect(withActiveSession(session, action)).rejects.toMatchObject({
      code: "PARTICIPANT_SESSION_NOT_ACTIVE",
    });
    expect(action).not.toHaveBeenCalled();
    execute.mockResolvedValue([{ id: "session_test" }]);
    await expect(withActiveSession(session, action)).resolves.toBe("signed");
  });
  it("strictly validates inputs and cannot accept replacement identity or permissions", () => {
    const input = { participantToken: "token", sessionId: "session_test" };
    expect(renewParticipantTokenBodySchema.parse(input).ttlSeconds).toBe(600);
    for (const patch of [
      { permissions: ["room:join", "video:publish"] },
      { participantId: "other" },
      { ttlSeconds: 59 },
      { ttlSeconds: 3601 },
      { sessionId: "" },
    ]) {
      expect(renewParticipantTokenBodySchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
});

describe("renewal token verification", () => {
  it("rejects forged signatures, wrong audience/issuer/kid and inconsistent registered claims", async () => {
    const now = new Date(+initial + 10000);
    const valid = await signer.sign(original);
    await expect(verifier.verify(valid, now)).resolves.toMatchObject(original);
    await expect(
      verifier.verify(
        await createParticipantTokenSigner({
          ...config,
          secret: "other-secret-which-is-at-least-32-chars",
        }).sign(original),
        now,
      ),
    ).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_TOKEN" });
    for (const patch of [{ audience: "other" }, { issuer: "other" }, { keyId: "other" }]) {
      await expect(
        verifier.verify(
          await createParticipantTokenSigner({ ...config, ...patch }).sign(original),
          now,
        ),
      ).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_TOKEN" });
    }
    const malformed = await new SignJWT({ ...original, permissions: ["room:join", "admin:all"] })
      .setProtectedHeader({ alg: "HS256", kid: config.keyId, typ: "JWT" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("someone-else")
      .setJti(original.tokenId)
      .setIssuedAt(+initial / 1000)
      .setExpirationTime(+initial / 1000 + 60)
      .sign(new TextEncoder().encode(config.secret));
    await expect(verifier.verify(malformed, now)).rejects.toMatchObject({
      code: "INVALID_PARTICIPANT_TOKEN",
    });
  });
});
