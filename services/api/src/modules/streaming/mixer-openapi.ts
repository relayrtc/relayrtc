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
  streamScopeSchema,
} from "@relayrtc/validation";
import {
  streamingOpenApiBase,
  streamingIdempotencyParameter,
  streamingPathParameter,
  streamingQueryParameters,
} from "./streaming-openapi.js";
export function mixerOpenApi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (name: string, status = 200) => ({
    [status]: {
      description: status === 202 ? "Accepted; poll the returned operation" : "Success",
      content: { "application/json": { schema: ref(name) } },
    },
  });
  const body = (name: string, required = true) => ({
    required,
    content: { "application/json": { schema: ref(name) } },
  });
  const path = streamingPathParameter;
  const scope = streamingQueryParameters(streamScopeSchema);
  const mutation = streamingIdempotencyParameter;
  const base = streamingOpenApiBase("RelayRTC cloud mixer", "cloud mixer management");
  const parameters = [...scope, path("mixerId")];
  return {
    ...base,
    paths: {
      "/broadcasts/{broadcastId}/mixers": {
        parameters: [...scope, path("broadcastId")],
        get: { responses: response("MixerList") },
        post: {
          parameters: [mutation],
          requestBody: body("CreateMixer", false),
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
      ...base.components,
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
