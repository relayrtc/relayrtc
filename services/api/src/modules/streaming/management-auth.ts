import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RelayKitDatabase } from "@relayrtc/database";
import { authenticateApiKey } from "../../authentication/api-key-authenticator.js";
import { assertClaimedScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import type { ConsoleSessionVerifier } from "../reporting/reporting.routes.js";
import type { Principal } from "./repository.js";

export function registerStreamingManagementAuth(
  app: FastifyInstance,
  options: {
    database: RelayKitDatabase;
    verifyConsoleSession?: ConsoleSessionVerifier;
    consoleOrigin?: string;
    acceptAudienceToken?: (token:string)=>boolean;
  },
) {
  const principals = new WeakMap<FastifyRequest, Principal>();
  app.decorateRequest("apiKey", null);
  app.decorateRequest("webhookPrincipal", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (request.headers.authorization !== undefined) {
      const token = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization)?.[1];
      if (token && options.acceptAudienceToken?.(token)) return;
      const key = token ? await authenticateApiKey(options.database, token) : null;
      if (!key) throw new ApiError(401, "INVALID_API_KEY", "Provide a valid secret API key");
      assertClaimedScope(request, key);
      request.apiKey = key;
      principals.set(request, { type: "key", key });
    } else {
      const headers = new Headers();
      if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
      const session = await options.verifyConsoleSession?.(headers);
      if (!session)
        throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide an API key or console session");
      if (
        !["GET", "HEAD"].includes(request.method) &&
        (!options.consoleOrigin || request.headers.origin !== options.consoleOrigin)
      )
        throw new ApiError(403, "ORIGIN_REQUIRED", "A trusted console Origin is required");
      principals.set(request, { type: "user", userId: session.userId });
      request.webhookPrincipal = { type: "session", userId: session.userId };
    }
  });
  return (request: FastifyRequest): Principal => {
    const principal = principals.get(request);
    if (!principal)
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");
    return principal;
  };
}
