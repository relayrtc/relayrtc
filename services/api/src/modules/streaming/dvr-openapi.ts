import { z } from "zod";
import {
  configureDvrSchema,
  updateDvrSchema,
  dvrPolicyResourceSchema,
  dvrPlaybackSchema,
  playbackGrantSchema,
  dvrPlaybackQuerySchema,
  streamScopeSchema,
} from "@relayrtc/validation";
import {
  streamingOpenApiBase,
  streamingIdempotencyParameter,
  streamingPathParameter,
  streamingQueryParameters,
} from "./streaming-openapi.js";
export function dvrOpenApi() {
  const json = (schema: z.ZodType, io: "input" | "output" = "output") => ({
    "application/json": { schema: z.toJSONSchema(schema, { io }) },
  });
  const responses = (schema: z.ZodType, code = "200") => ({
    [code]: { description: "Success", content: json(schema) },
  });
  const parameters = [
    streamingPathParameter("streamId"),
    ...streamingQueryParameters(dvrPlaybackQuerySchema),
  ];
  return {
    ...streamingOpenApiBase(
      "RelayRTC live DVR",
      "DVR policies, playback metadata and shared playback grants",
    ),
    paths: {
      "/streams/{streamId}/dvr-policy": {
        parameters,
        get: { responses: responses(dvrPolicyResourceSchema) },
        post: {
          parameters: [streamingIdempotencyParameter],
          requestBody: { required: true, content: json(configureDvrSchema, "input") },
          responses: responses(dvrPolicyResourceSchema, "201"),
        },
        patch: {
          parameters: [streamingIdempotencyParameter],
          requestBody: { required: true, content: json(updateDvrSchema, "input") },
          responses: responses(dvrPolicyResourceSchema),
        },
      },
      "/streams/{streamId}/playback-grants": {
        parameters: [
          streamingPathParameter("streamId"),
          ...streamingQueryParameters(streamScopeSchema),
        ],
        post: {
          description:
            "Issue a live or DVR viewer grant. Set mode to dvr for DVR playback. This operation does not use Idempotency-Key.",
          requestBody: { required: false, content: json(playbackGrantSchema, "input") },
          responses: responses(
            z.object({ url: z.string(), token: z.string(), expiresAt: z.string() }),
          ),
        },
      },
      "/streams/{streamId}/dvr-playback": {
        parameters,
        get: { responses: responses(dvrPlaybackSchema) },
      },
    },
  };
}
