import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import { z } from "zod";
import { participantIdSchema, roomIdSchema, sessionIdSchema } from "@relayrtc/validation";

import { requireApiKeyScope } from "../../authentication/authentication-plugin.js";
import { ApiError } from "../../http/errors/api-error.js";
import type { TurnCredentialIssuer, TurnCredentialScope } from "./turn-credential.service.js";

interface TurnCredentialRoutesOptions {
  issuer: TurnCredentialIssuer;
}

const requestScope = (request: FastifyRequest): TurnCredentialScope => {
  const principal = request.apiKey;
  if (!principal) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Provide a valid API key");
  }
  return {
    environmentId: principal.environmentId,
    projectId: principal.projectId,
  };
};

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expiresAt", "iceServers", "ttlSeconds", "username"],
  properties: {
    expiresAt: { type: "string", format: "date-time" },
    iceServers: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["urls"],
        properties: {
          urls: { type: "array", minItems: 1, items: { type: "string" } },
          username: { type: "string" },
          credential: { type: "string" },
          credentialType: { const: "password" },
        },
      },
    },
    ttlSeconds: { type: "integer", minimum: 60, maximum: 3_600 },
    username: { type: "string" },
  },
} as const;

export const turnCredentialRoutes: FastifyPluginCallback<TurnCredentialRoutesOptions> = (
  app,
  options,
  done,
) => {
  app.post(
    "/turn/credentials",
    {
      preHandler: requireApiKeyScope("tokens:create"),
      schema: { response: { 201: responseSchema } },
    },
    async (request, reply) => {
      const parsed = z
        .object({
          roomId: roomIdSchema.optional(),
          sessionId: sessionIdSchema.optional(),
          participantId: participantIdSchema.optional(),
        })
        .strict()
        .refine(
          (value) =>
            (value.roomId === undefined) === (value.sessionId === undefined) &&
            (!value.participantId || !!value.sessionId),
          "Provide roomId and sessionId together",
        )
        .safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "Provide valid roomId and sessionId together, or an empty body",
        );
      const body = parsed.data;
      const credentials = await options.issuer.issue({
        ...requestScope(request),
        ...(body.roomId && body.sessionId
          ? {
              roomId: body.roomId,
              sessionId: body.sessionId,
              ...(body.participantId ? { participantId: body.participantId } : {}),
            }
          : {}),
      });
      return reply.status(201).send(credentials);
    },
  );
  done();
};
