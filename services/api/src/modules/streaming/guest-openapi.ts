import { z } from "zod";
import {
  guestStageSchema,
  audienceGrantSchema,
  inviteGuestSchema,
  guestRequestSchema,
  guestDecisionSchema,
  guestMuteSchema,
  guestResourceSchema,
  guestRosterSchema,
  guestJoinGrantSchema,
} from "@relayrtc/validation";
export function guestOpenApi() {
  const content = (schema: z.ZodType) => ({
    "application/json": { schema: z.toJSONSchema(schema) },
  });
  const operation = (
    input: z.ZodType | undefined,
    output: z.ZodType,
    status = 200,
    idempotent = true,
  ) => ({
    ...(input
      ? {
          parameters: [
            {
              in: "header",
              name: "Idempotency-Key",
              required: idempotent,
              schema: { type: "string", maxLength: 128 },
            },
          ],
          requestBody: { required: true, content: content(input) },
        }
      : {}),
    responses: { [status]: { description: "Success", content: content(output) } },
  });
  const parameters = [
    { in: "path", name: "streamId", required: true, schema: { type: "string" } },
    { in: "query", name: "broadcastId", required: true, schema: { type: "string" } },
    ...["projectId", "environmentId", "subject", "cursor"].map((name) => ({
      in: "query",
      name,
      schema: { type: "string" },
    })),
    {
      in: "query",
      name: "limit",
      schema: { type: "integer", minimum: 1, maximum: 50, default: 25 },
    },
  ];
  const paths: Record<string, unknown> = {};
  paths["/streams/{streamId}/guest-stage"] = {
    parameters,
    get: operation(undefined, guestRosterSchema.shape.stage),
    put: operation(guestStageSchema, guestRosterSchema.shape.stage),
  };
  paths["/streams/{streamId}/audience-grants"] = {
    parameters,
    post: operation(
      audienceGrantSchema,
      z.object({ token: z.string(), expiresAt: z.string(), audienceId: z.string() }),
      201,
      false,
    ),
  };
  for (const name of ["invites", "guest-requests", "guests", "guest-status"])
    paths[`/streams/{streamId}/${name}`] = {
      parameters,
      get: operation(undefined, guestRosterSchema),
      ...(name === "invites" || name === "guest-requests"
        ? {
            post: operation(
              name === "invites" ? inviteGuestSchema : guestRequestSchema,
              guestResourceSchema,
              201,
            ),
          }
        : {}),
    };
  for (const [collection, param, actions] of [
    ["invites", "inviteId", ["accept", "decline", "cancel"]],
    ["guest-requests", "requestId", ["approve", "reject"]],
    ["guests", "guestId", ["leave", "remove", "mute", "join-grant"]],
  ] as const)
    for (const action of actions)
      paths[`/streams/{streamId}/${collection}/{${param}}/${action}`] = {
        parameters: [
          ...parameters,
          { in: "path", name: param, required: true, schema: { type: "string" } },
        ],
        post: operation(
          action === "mute" ? guestMuteSchema : guestDecisionSchema,
          action === "join-grant" ? guestJoinGrantSchema : guestResourceSchema,
          action === "join-grant" ? 201 : 200,
          action !== "join-grant",
        ),
      };
  return {
    openapi: "3.1.0",
    info: { title: "RelayRTC live guests", version: "0.9.0" },
    servers: [{ url: "/v1" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Management key or narrow run-bound audience identity; role and subject checks still apply.",
        },
      },
    },
    paths,
  };
}
