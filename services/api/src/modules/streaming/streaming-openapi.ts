import { z } from "zod";
import { streamingIdSchema } from "@relayrtc/validation";

/** The public route contract, independent of server releases and SDK package versions. */
export const streamingApiContractVersion = "v1";

export function streamingOpenApiBase(title: string, slice: string, acceptsAudience = false) {
  return {
    openapi: "3.1.0",
    info: {
      title,
      version: streamingApiContractVersion,
      description:
        `Partial OpenAPI document for ${slice}; it does not describe the complete streaming API. ` +
        "The document version identifies the public /v1 contract, not a RelayRTC release or SDK version. " +
        "Schemas are derived from shared validators; cross-field validation, authorization and runtime policies remain authoritative. " +
        "These routes and this document require streaming to be enabled and authentication. " +
        "Console-session mutations also require the configured console Origin header.",
    },
    servers: [{ url: "/v1" }],
    security: [{ bearerAuth: [] }, { consoleSession: [] }, { secureConsoleSession: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: acceptsAudience
            ? "A secret management API key or a run-bound audience grant where the operation permits it. Role, subject and permission checks still apply."
            : "A secret management API key. Project, environment and permission checks still apply.",
        },
        consoleSession: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description:
            "Signed console session on HTTP deployments; mutations require the trusted console Origin.",
        },
        secureConsoleSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-better-auth.session_token",
          description:
            "Signed console session on HTTPS deployments; mutations require the trusted console Origin.",
        },
      },
    },
  };
}

export const streamingIdempotencyParameter = {
  in: "header",
  name: "Idempotency-Key",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
  description: "Reuse with the identical command when retrying an uncertain result.",
};

export const streamingPathParameter = (name: string) => ({
  in: "path",
  name,
  required: true,
  schema: z.toJSONSchema(streamingIdSchema),
});

/** Use output constraints for query coercion, but input requiredness for defaulted fields. */
export function streamingQueryParameters(schema: z.ZodObject) {
  const input = z.toJSONSchema(schema, { io: "input" });
  const output = z.toJSONSchema(schema);
  return Object.entries(output.properties ?? {}).map(([name, property]) => ({
    in: "query",
    name,
    required: input.required?.includes(name) ?? false,
    schema: property,
  }));
}
