import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { RelayKitDatabase } from "@relayrtc/database";
import { participantTokenRoutes } from "./participant-token.routes.js";
import { createParticipantTokenSigner } from "./participant-token.signer.js";
import { createParticipantTokenVerifier } from "./participant-token.verifier.js";
import { registerErrorHandling } from "../../http/errors/error-handler.js";

const config = {
  secret: "a-secure-participant-token-secret-123",
  audience: "relayrtc-realtime",
  issuer: "relayrtc-api",
  keyId: "participant-v1",
};
describe("participant renewal route", () => {
  it.each(["valid", "no-scope", "publishable", "inactive", "bad-token", "override"])(
    "handles %s requests through the real route",
    async (mode) => {
      const app = Fastify();
      registerErrorHandling(app);
      app.decorateRequest("apiKey", null);
      app.addHook("onRequest", async (request) => {
        request.apiKey = {
          projectId: "project_test",
          environmentId: "env_test",
          keyId: "key_test",
          keyType: mode === "publishable" ? "publishable" : "secret",
          scopes: mode === "no-scope" ? [] : ["tokens:create"],
        };
        return Promise.resolve();
      });
      const database = {
        transaction: async (action: (tx: unknown) => Promise<unknown>) =>
          action({
            execute: () => Promise.resolve(mode === "inactive" ? [] : [{ id: "session_test" }]),
          }),
      } as unknown as RelayKitDatabase;
      const signer = createParticipantTokenSigner(config);
      await app.register(participantTokenRoutes, {
        database,
        signer,
        verifier: createParticipantTokenVerifier(config),
      });
      try {
        const now = Date.now();
        const token = await signer.sign({
          projectId: "project_test",
          environmentId: "env_test",
          roomId: "room_test",
          participantId: "participant_test",
          participantName: "Ada",
          metadata: {},
          permissions: ["room:join"],
          tokenId: "ptok_original",
          issuedAt: new Date(now - 30000).toISOString(),
          expiresAt: new Date(now + 30000).toISOString(),
        });
        const response = await app.inject({
          method: "POST",
          url: "/rooms/room_test/tokens/renew",
          payload: {
            participantToken: mode === "bad-token" ? "forged" : token,
            sessionId: "session_test",
            ttlSeconds: 60,
            ...(mode === "override" ? { permissions: ["room:join", "video:publish"] } : {}),
          },
        });
        if (mode === "valid") {
          expect(response.statusCode).toBe(201);
          expect(response.headers["cache-control"]).toBe("no-store");
          const payload = response.json<{ participantId: string; tokenId: string }>();
          expect(payload.participantId).toBe("participant_test");
          expect(payload.tokenId).not.toBe("ptok_original");
        } else {
          expect(response.statusCode).toBe(
            mode === "bad-token" ? 401 : mode === "override" ? 400 : 403,
          );
          expect(response.body).not.toContain(token);
        }
      } finally {
        await app.close();
      }
    },
  );
});
