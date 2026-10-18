import { z } from "zod";
import {
  configureDvrSchema,
  updateDvrSchema,
  dvrPolicyResourceSchema,
  dvrPlaybackSchema,
  playbackGrantSchema,
} from "@relayrtc/validation";
export function dvrOpenApi() {
  const json = (schema: z.ZodType) => ({
    "application/json": { schema: z.toJSONSchema(schema) },
  });
  const responses = (schema: z.ZodType, code = "200") => ({
    [code]: { description: "Success", content: json(schema) },
  });
  return {
    openapi: "3.1.0",
    info: { title: "RelayRTC live DVR", version: "0.8.0" },
    servers: [{ url: "/v1" }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/streams/{streamId}/dvr-policy": {
        parameters: [{ in: "path", name: "streamId", required: true, schema: { type: "string" } }],
        get: { responses: responses(dvrPolicyResourceSchema) },
        post: {
          parameters: [
            { in: "header", name: "Idempotency-Key", schema: { type: "string", maxLength: 128 } },
          ],
          requestBody: { required: true, content: json(configureDvrSchema) },
          responses: responses(dvrPolicyResourceSchema, "201"),
        },
        patch: {
          parameters: [
            { in: "header", name: "Idempotency-Key", schema: { type: "string", maxLength: 128 } },
          ],
          requestBody: { required: true, content: json(updateDvrSchema) },
          responses: responses(dvrPolicyResourceSchema),
        },
      },
      "/streams/{streamId}/playback-grants": {
        parameters: [{ in: "path", name: "streamId", required: true, schema: { type: "string" } }],
        post: {
          requestBody: { required: true, content: json(playbackGrantSchema) },
          responses: responses(
            z.object({ url: z.string(), token: z.string(), expiresAt: z.string() }),
          ),
        },
      },
      "/streams/{streamId}/dvr-playback": {
        parameters: [
          { in: "path", name: "streamId", required: true, schema: { type: "string" } },
          { in: "query", name: "broadcastId", schema: { type: "string" } },
        ],
        get: { responses: responses(dvrPlaybackSchema) },
      },
    },
  };
}
