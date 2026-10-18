import { verifyMediaControlToken, type MediaControlClaims } from "@relayrtc/protocol/media-control";
import type { FastifyInstance, FastifyRequest } from "fastify";

const roomRoutes = new Set([
  "POST /internal/v1/rooms/:roomId",
  "DELETE /internal/v1/rooms/:roomId",
  "GET /internal/v1/rooms/:roomId/capabilities",
  "GET /internal/v1/rooms/:roomId/tracks",
]);

const participantRoutes = new Set([
  "GET /internal/v1/rooms/:roomId/capabilities",
  "GET /internal/v1/rooms/:roomId/tracks",
  "POST /internal/v1/rooms/:roomId/transports",
  "PATCH /internal/v1/rooms/:roomId/transports/:transportId",
  "POST /internal/v1/rooms/:roomId/transports/:transportId/restart-ice",
  "POST /internal/v1/rooms/:roomId/tracks",
  "POST /internal/v1/rooms/:roomId/subscriptions",
  "POST /internal/v1/rooms/:roomId/stats",
  "PATCH /internal/v1/rooms/:roomId/subscriptions/:subscriptionId/resume",
  "DELETE /internal/v1/rooms/:roomId/subscriptions/:subscriptionId",
  "PATCH /internal/v1/rooms/:roomId/subscriptions/:subscriptionId/quality",
  "PATCH /internal/v1/rooms/:roomId/participants/:participantId/priority",
  "PATCH /internal/v1/rooms/:roomId/participants/:participantId/quality-mode",
  "PATCH /internal/v1/rooms/:roomId/participants/:participantId/tracks/:trackId/priority",
  "DELETE /internal/v1/rooms/:roomId/participants/:participantId/tracks/:trackId",
]);

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const matchesAuthority = (request: FastifyRequest, claims: MediaControlClaims): boolean => {
  if (claims.method !== request.method || claims.path !== request.url) return false;
  const route = `${request.method} ${request.routeOptions.url ?? ""}`;
  const authority = claims.authority;
  if (authority.kind === "capacity") return route === "GET /internal/v1/capacity";
  const params = record(request.params);
  if (params?.roomId !== authority.roomId) return false;
  if (authority.kind === "room") return roomRoutes.has(route);
  if (authority.kind === "participant-cleanup")
    return (
      route === "DELETE /internal/v1/rooms/:roomId/participants/:participantId" &&
      params.participantId === authority.participantId
    );
  if (!participantRoutes.has(route)) return false;
  const body = record(request.body);
  if (params.participantId !== undefined && params.participantId !== authority.participantId)
    return false;
  if (body?.participantId !== undefined && body.participantId !== authority.participantId)
    return false;
  if (body?.sessionId !== undefined && body.sessionId !== authority.sessionId) return false;
  if (body && "participantId" in body) body.participantId = authority.participantId;
  if ("participantId" in params) params.participantId = authority.participantId;
  return true;
};

export const registerInternalAuthentication = (
  app: FastifyInstance,
  secret: string,
  authorizeLive?: (request: FastifyRequest, claims: MediaControlClaims) => Promise<boolean>,
): void => {
  if (secret.length < 32)
    throw new Error("Media control requires an internal secret of at least 32 characters");
  const authenticated = new WeakMap<FastifyRequest, MediaControlClaims>();

  app.addHook("onRequest", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    const claims = verifyMediaControlToken(secret, token);
    if (!claims) {
      reply.header("www-authenticate", 'Bearer realm="relayrtc-media-control"');
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        description: "Valid media control credentials are required",
      });
    }
    authenticated.set(request, claims);
  });

  app.addHook("preValidation", async (request, reply) => {
    const claims = authenticated.get(request);
    if (
      !claims ||
      !matchesAuthority(request, claims) ||
      (authorizeLive && !(await authorizeLive(request, claims)))
    )
      return reply.code(403).send({
        code: "FORBIDDEN",
        description: "The media control grant does not authorize this operation",
      });
  });
};
