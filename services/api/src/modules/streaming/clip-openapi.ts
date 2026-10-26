import { z } from "zod";
import {
  createClipSchema,
  clipResourceSchema,
  clipWindowSchema,
  rollingBufferPolicySchema,
  streamScopeSchema,
  streamingIdSchema,
} from "@relayrtc/validation";
import {
  streamingOpenApiBase,
  streamingIdempotencyParameter,
  streamingPathParameter,
  streamingQueryParameters,
} from "./streaming-openapi.js";

/** OpenAPI for the clip slice, derived from the same validators used by the API and console. */
export function clipOpenApi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (schema: unknown, status = 200) => ({
    [status]: {
      description: status === 202 ? "Accepted; poll the returned clip resource" : "Success",
      content: { "application/json": { schema } },
    },
  });
  const body = (schema: unknown, required = true) => ({
    required,
    content: { "application/json": { schema } },
  });
  const scope = streamingQueryParameters(streamScopeSchema);
  const path = streamingPathParameter;
  const mutation = streamingIdempotencyParameter;
  const base = streamingOpenApiBase(
    "RelayRTC clips and rolling buffers",
    "clips and rolling buffers",
  );
  const list = {
    summary: "List clips",
    parameters: streamingQueryParameters(
      z.object({
        cursor: streamingIdSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
    ),
    responses: response(ref("ClipPage")),
  };
  const clip = { parameters: [...scope, path("clipId")] },
    stream = { parameters: [...scope, path("streamId")] };
  return {
    ...base,
    paths: {
      "/clips": {
        parameters: scope,
        get: {
          ...list,
          description:
            "Console sessions must select projectId and environmentId. Secret-key scope is derived from the credential unless supplied and matching.",
        },
      },
      "/streams/{streamId}/clips": {
        ...stream,
        get: list,
        post: {
          summary: "Request a retained interval",
          parameters: [mutation],
          requestBody: body(ref("CreateClip")),
          responses: response(ref("Clip"), 202),
        },
      },
      "/streams/{streamId}/clip-window": {
        ...stream,
        get: {
          summary: "Read retained source intervals",
          responses: response({
            type: "object",
            required: ["data"],
            properties: { data: { type: "array", items: ref("ClipWindow") } },
          }),
        },
      },
      "/streams/{streamId}/buffer-policy": {
        ...stream,
        get: {
          summary: "Get rolling buffer policy",
          responses: response(ref("BufferPolicyResult")),
        },
        put: {
          summary: "Update rolling buffer policy with its current version",
          parameters: [mutation],
          requestBody: body(ref("BufferPolicyUpdate")),
          responses: response(ref("BufferPolicyResult")),
        },
      },
      "/clips/{clipId}": {
        ...clip,
        get: { summary: "Observe a clip job", responses: response(ref("Clip")) },
        delete: {
          summary: "Revoke access and schedule deletion",
          parameters: [mutation],
          responses: response(ref("Clip"), 202),
        },
      },
      "/clips/{clipId}/publish": {
        ...clip,
        post: {
          summary: "Permit application-authorized viewer grants for a ready clip",
          parameters: [mutation],
          requestBody: body({ type: "object", additionalProperties: false }, false),
          responses: response(ref("Clip")),
        },
      },
    },
    components: {
      ...base.components,
      schemas: {
        CreateClip: z.toJSONSchema(createClipSchema, { io: "input" }),
        Clip: z.toJSONSchema(clipResourceSchema),
        ClipWindow: z.toJSONSchema(clipWindowSchema),
        ClipPage: {
          type: "object",
          required: ["data", "nextCursor"],
          properties: {
            data: { type: "array", items: ref("Clip") },
            nextCursor: { type: ["string", "null"] },
          },
        },
        BufferPolicyUpdate: z.toJSONSchema(
          z
            .object({ version: z.number().int().nonnegative(), policy: rollingBufferPolicySchema })
            .strict(),
          { io: "input" },
        ),
        BufferPolicyResult: z.toJSONSchema(
          z.object({
            version: z.number().int().nonnegative(),
            policy: rollingBufferPolicySchema.nullable(),
          }),
        ),
      },
    },
  };
}
