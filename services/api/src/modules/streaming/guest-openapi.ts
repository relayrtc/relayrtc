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
  guestQuerySchema,
} from "@relayrtc/validation";
import {
  streamingOpenApiBase,
  streamingIdempotencyParameter,
  streamingPathParameter,
  streamingQueryParameters,
} from "./streaming-openapi.js";
export function guestOpenApi() {
  const content = (schema: z.ZodType, io: "input" | "output" = "output") => ({
    "application/json": { schema: z.toJSONSchema(schema, { io }) },
  });
  const operation = (
    input: z.ZodType | undefined,
    output: z.ZodType,
    status = 200,
    idempotent = true,
  ) => ({
    ...(input
      ? {
          ...(idempotent ? { parameters: [streamingIdempotencyParameter] } : {}),
          requestBody: { required: true, content: content(input, "input") },
        }
      : {}),
    responses: { [status]: { description: "Success", content: content(output) } },
  });
  const parameters = [
    streamingPathParameter("streamId"),
    ...streamingQueryParameters(guestQuerySchema),
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
        parameters: [...parameters, streamingPathParameter(param)],
        post: operation(
          action === "mute" ? guestMuteSchema : guestDecisionSchema,
          action === "join-grant" ? guestJoinGrantSchema : guestResourceSchema,
          action === "join-grant" ? 201 : 200,
          action !== "join-grant",
        ),
      };
  return {
    ...streamingOpenApiBase("RelayRTC live guests", "live guests and co-hosting", true),
    paths,
  };
}
