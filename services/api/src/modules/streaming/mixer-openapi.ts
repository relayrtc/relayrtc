import { z } from "zod";
import {
  createMixerSchema,
  putMixerSceneSchema,
  activateMixerSceneSchema,
  createMixerOverlaySchema,
  mixerResourceSchema,
  mixerSceneResourceSchema,
  mixerOperationSchema,
  mixerCommandResultSchema,
  mixerOverlaySchema,
} from "@relayrtc/validation";
export function mixerOpenApi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (name: string, status = 200) => ({
    [status]: {
      description: status === 202 ? "Accepted; poll the returned operation" : "Success",
      content: { "application/json": { schema: ref(name) } },
    },
  });
  const body = (name: string) => ({
    required: true,
    content: { "application/json": { schema: ref(name) } },
  });
  const path = (name: string) => ({
    in: "path",
    name,
    required: true,
    schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
  });
  const scope = ["projectId", "environmentId"].map((name) => ({
    in: "query",
    name,
    required: false,
    schema: { type: "string" },
  }));
  const mutation = {
    in: "header",
    name: "Idempotency-Key",
    schema: { type: "string", maxLength: 128 },
    description: "Reuse with the identical request when retrying an uncertain command.",
  };
  const parameters = [...scope, path("mixerId")];
  return {
    openapi: "3.1.0",
    info: { title: "RelayRTC cloud mixer", version: "0.7.0" },
    servers: [{ url: "/v1" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/broadcasts/{broadcastId}/mixers": {
        parameters: [...scope, path("broadcastId")],
        get: { responses: response("MixerList") },
        post: {
          parameters: [mutation],
          requestBody: body("CreateMixer"),
          responses: response("Mixer", 201),
        },
      },
      "/mixers/{mixerId}": { parameters, get: { responses: response("Mixer") } },
      "/mixers/{mixerId}/scenes": { parameters, get: { responses: response("SceneList") } },
      "/mixers/{mixerId}/scenes/{sceneId}": {
        parameters: [...parameters, path("sceneId")],
        put: {
          parameters: [mutation],
          requestBody: body("PutScene"),
          responses: response("Scene"),
        },
      },
      "/mixers/{mixerId}/activate-scene": {
        parameters,
        post: {
          parameters: [mutation],
          requestBody: body("ActivateScene"),
          responses: response("Command", 202),
        },
      },
      "/mixers/{mixerId}/overlays": {
        parameters,
        post: {
          parameters: [mutation],
          requestBody: body("CreateOverlay"),
          responses: response("Overlay", 201),
        },
      },
      "/mixers/{mixerId}/overlays/{overlayId}": {
        parameters: [...parameters, path("overlayId")],
        delete: { parameters: [mutation], responses: response("Deleted") },
      },
      "/mixers/{mixerId}/stop": {
        parameters,
        post: {
          parameters: [mutation],
          requestBody: body("StopMixer"),
          responses: response("Command", 202),
        },
      },
      "/mixer-operations/{operationId}": {
        parameters: [...scope, path("operationId")],
        get: { responses: response("Operation") },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        CreateMixer: z.toJSONSchema(createMixerSchema, { io: "input" }),
        PutScene: z.toJSONSchema(putMixerSceneSchema, { io: "input" }),
        ActivateScene: z.toJSONSchema(activateMixerSceneSchema, { io: "input" }),
        CreateOverlay: z.toJSONSchema(createMixerOverlaySchema, { io: "input" }),
        StopMixer: z.toJSONSchema(z.object({ version: z.number().int().positive() }).strict()),
        Mixer: z.toJSONSchema(mixerResourceSchema),
        Scene: z.toJSONSchema(mixerSceneResourceSchema),
        Overlay: z.toJSONSchema(mixerOverlaySchema),
        Operation: z.toJSONSchema(mixerOperationSchema),
        Command: z.toJSONSchema(mixerCommandResultSchema),
        MixerList: {
          type: "object",
          properties: { data: { type: "array", maxItems: 10, items: ref("Mixer") } },
          required: ["data"],
        },
        SceneList: {
          type: "object",
          properties: { data: { type: "array", maxItems: 12, items: ref("Scene") } },
          required: ["data"],
        },
        Deleted: {
          type: "object",
          properties: { id: { type: "string" }, deleted: { const: true } },
          required: ["id", "deleted"],
        },
      },
    },
  };
}
