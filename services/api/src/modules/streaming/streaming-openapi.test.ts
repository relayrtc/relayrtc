import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as validators from "@relayrtc/validation";
import { clipOpenApi } from "./clip-openapi.js";
import { mixerOpenApi } from "./mixer-openapi.js";
import { dvrOpenApi } from "./dvr-openapi.js";
import { guestOpenApi } from "./guest-openapi.js";
import { streamingApiContractVersion } from "./streaming-openapi.js";

interface Schema {
  $ref?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  pattern?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}
interface Parameter {
  in: string;
  name: string;
  required?: boolean;
  schema: Schema;
}
interface Operation {
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: { "application/json": { schema: Schema } } };
  responses: Record<string, { content: { "application/json": { schema: Schema } } }>;
}
interface PathItem {
  parameters?: Parameter[];
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
}
interface Document {
  openapi: string;
  info: { version: string; description: string };
  servers: { url: string }[];
  security: Record<string, never[]>[];
  components: { schemas?: Record<string, Schema>; securitySchemes: Record<string, unknown> };
  paths: Record<string, PathItem>;
}

const documents = {
  clips: clipOpenApi() as unknown as Document,
  mixers: mixerOpenApi() as unknown as Document,
  dvr: dvrOpenApi() as unknown as Document,
  guests: guestOpenApi() as unknown as Document,
};
const methods = ["get", "post", "put", "patch", "delete"] as const;
const sourceFiles = {
  clips: "clip-routes",
  mixers: "mixer-routes",
  dvr: "dvr-routes",
  guests: "guest-routes",
};
type Method = (typeof methods)[number];
interface Request {
  body?: unknown;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string>;
}
interface Reply {
  code: (status: number) => Reply;
  send: (body: unknown) => unknown;
}
type Handler = (request: Request, reply: Reply) => unknown;
interface RegisteredRoute {
  method: Method;
  path: string;
  handler: Handler;
}

/** Evaluate real registration, including its loops, without importing or running database/media services. */
async function registeredRoutes(source: string): Promise<RegisteredRoute[]> {
  const routes: RegisteredRoute[] = [];
  const normalizePath = (path: string) => path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, "{$1}");
  const app = {
    ...Object.fromEntries(
      methods.map((method) => [
        method,
        (path: string, ...args: unknown[]) => {
          routes.push({ method, path: normalizePath(path), handler: args.at(-1) as Handler });
        },
      ]),
    ),
    route(options: { method: string; url: string; handler: Handler }) {
      routes.push({
        method: options.method.toLowerCase() as Method,
        path: normalizePath(options.url),
        handler: options.handler,
      });
    },
  };
  const exports: Record<string, (app: unknown, options: unknown) => Promise<void>> = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL(`./${source}.ts`, import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    },
  ).outputText;
  class InertService {
    readonly registrationOnly = true;
  }
  runInNewContext(
    compiled,
    {
      exports,
      Buffer,
      require(name: string) {
        if (name === "zod") return { z };
        if (name === "@relayrtc/validation") return validators;
        if (name === "node:crypto") return crypto;
        return {
          registerStreamingManagementAuth: () => () => {
            throw new Error("A contract check must not authenticate a request");
          },
          createParticipantTokenSigner: () => ({}),
          validate: (schema: z.ZodType, value: unknown) => schema.parse(value),
          StreamingStore: InertService,
          StreamingOrigin: InertService,
          clipOpenApi,
          mixerOpenApi,
          dvrOpenApi,
          guestOpenApi,
        };
      },
    },
    { timeout: 1000 },
  );
  const plugin = Object.values(exports)[0];
  if (!plugin) throw new Error(`No route plugin exported by ${source}`);
  await plugin(app, {
    database: { transaction: () => Promise.resolve({}) },
    config: { secret: "contract-test-streaming-secret-with-32-characters" },
    participantSigner: {},
  });
  return routes;
}

function resolveSchema(document: Document, schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "");
  const resolved = document.components.schemas?.[name];
  if (!resolved) throw new Error(`Unresolved schema ${schema.$ref}`);
  return resolved;
}

function inputSchema(document: Document, path: string, method: Method): Schema {
  const schema = document.paths[path]?.[method]?.requestBody?.content["application/json"].schema;
  if (!schema) throw new Error(`Missing request schema: ${method} ${path}`);
  return resolveSchema(document, schema);
}

describe("streaming OpenAPI contracts", () => {
  for (const [slice, document] of Object.entries(documents)) {
    it(`${slice} identifies its partial v1 contract and real authentication modes`, () => {
      expect(document.openapi).toBe("3.1.0");
      expect(document.info.version).toBe(streamingApiContractVersion);
      expect(document.info.version).toBe("v1");
      expect(document.info.description).toContain("Partial OpenAPI");
      expect(document.info.description).toContain("not a RelayRTC release or SDK version");
      expect(document.info.description).toContain("Origin header");
      expect(document.servers).toEqual([{ url: "/v1" }]);
      for (const alternative of document.security) {
        for (const name of Object.keys(alternative))
          expect(document.components.securitySchemes[name]).toBeDefined();
      }
      expect(document.security).toEqual([
        { bearerAuth: [] },
        { consoleSession: [] },
        { secureConsoleSession: [] },
      ]);
    });

    it(`${slice} references only registered routes and covers its own management slice`, async () => {
      const source = sourceFiles[slice as keyof typeof sourceFiles];
      const registered = await registeredRoutes(source);
      const available = [
        ...registered,
        ...(slice === "dvr" ? await registeredRoutes("routes") : []),
      ];
      const described = new Set<string>();
      for (const [path, item] of Object.entries(document.paths)) {
        for (const method of methods) {
          if (!item[method]) continue;
          const route = `${method} ${path}`;
          described.add(route);
          expect(
            available.some((r) => r.method === method && r.path === path),
            route,
          ).toBe(true);
        }
      }
      for (const route of registered.filter((r) => !r.path.endsWith("/openapi"))) {
        expect(
          described.has(`${route.method} ${route.path}`),
          `${route.method} ${route.path}`,
        ).toBe(true);
      }
      expect(registered.some((r) => r.method === "get" && r.path === `/${slice}/openapi`)).toBe(
        true,
      );
    });

    it(`${slice} resolves schema references and declares every path parameter`, () => {
      const visit = (value: unknown) => {
        if (value === null || typeof value !== "object") return;
        if ("$ref" in value && typeof value.$ref === "string")
          resolveSchema(document, value as Schema);
        for (const child of Object.values(value)) visit(child);
      };
      visit(document);
      for (const [path, item] of Object.entries(document.paths)) {
        const names = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
        for (const method of methods) {
          const operation = item[method];
          if (!operation) continue;
          const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
          expect(new Set(parameters.map((p) => `${p.in}:${p.name}`)).size).toBe(parameters.length);
          for (const name of names) {
            expect(parameters.find((p) => p.in === "path" && p.name === name)?.required, path).toBe(
              true,
            );
          }
          expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
        }
      }
    });

    it(`${slice} requires idempotency only for commands that use the idempotency store`, () => {
      for (const [path, item] of Object.entries(document.paths)) {
        for (const method of methods.filter((m) => m !== "get")) {
          const operation = item[method];
          if (!operation) continue;
          const grant = /\/(?:playback-grants|audience-grants|join-grant)$/u.test(path);
          const key = operation.parameters?.find(
            (p) => p.in === "header" && p.name === "Idempotency-Key",
          );
          if (grant) {
            expect(key, path).toBeUndefined();
          } else {
            expect(key?.required, path).toBe(true);
            expect(key?.schema.pattern).toBe("^[A-Za-z0-9_.:-]{1,128}$");
          }
        }
      }
    });
  }

  it("documents defaulted DVR policy inputs as optional and response fields as required", () => {
    const document = documents.dvr;
    const input = inputSchema(document, "/streams/{streamId}/dvr-policy", "post");
    expect(
      validators.configureDvrSchema.safeParse({
        policy: { enabled: false, consentAcknowledged: true },
      }).success,
    ).toBe(true);
    expect(input.properties?.policy?.required).toEqual(["enabled", "consentAcknowledged"]);
    expect(input.properties?.policy?.properties?.durationSeconds?.default).toBe(300);
    const response =
      document.paths["/streams/{streamId}/dvr-policy"]?.get?.responses["200"]?.content[
        "application/json"
      ].schema;
    expect(response?.required).toContain("effective");
    expect(response?.properties?.policy).toBeDefined();
  });

  it("preserves optional guest defaults without weakening output contracts", () => {
    const document = documents.guests;
    const stage = inputSchema(document, "/streams/{streamId}/guest-stage", "put");
    expect(validators.guestStageSchema.safeParse({ enabled: true, version: 0 }).success).toBe(true);
    expect(stage.required).toEqual(["enabled", "version"]);
    const grant = inputSchema(document, "/streams/{streamId}/audience-grants", "post");
    expect(grant.required).toEqual(["subject", "name"]);
    const invite = inputSchema(document, "/streams/{streamId}/invites", "post");
    expect(invite.properties?.media?.required ?? []).toEqual([]);
    const response =
      document.paths["/streams/{streamId}/guest-stage"]?.get?.responses["200"]?.content[
        "application/json"
      ].schema;
    expect(response?.required).toContain("occupied");
    expect(response?.required).toContain("maxGuests");
  });

  it("keeps optional bodies and scoped query defaults consistent with validators", () => {
    expect(
      documents.mixers.paths["/broadcasts/{broadcastId}/mixers"]?.post?.requestBody?.required,
    ).toBe(false);
    expect(documents.clips.paths["/clips/{clipId}/publish"]?.post?.requestBody?.required).toBe(
      false,
    );
    expect(
      documents.dvr.paths["/streams/{streamId}/playback-grants"]?.post?.requestBody?.required,
    ).toBe(false);
    expect(validators.createMixerSchema.safeParse({}).success).toBe(true);
    expect(validators.playbackGrantSchema.safeParse({}).success).toBe(true);
    const guest = documents.guests.paths["/streams/{streamId}/guests"]?.parameters;
    expect(guest?.find((p) => p.name === "broadcastId")?.required).toBe(true);
    expect(guest?.find((p) => p.name === "limit")?.required).toBe(false);
    expect(guest?.find((p) => p.name === "limit")?.schema).toMatchObject({
      minimum: 1,
      maximum: 50,
      default: 25,
    });
    const dvr = documents.dvr.paths["/streams/{streamId}/dvr-policy"]?.parameters;
    expect(dvr?.filter((p) => p.in === "query").map((p) => p.name)).toEqual([
      "projectId",
      "environmentId",
      "broadcastId",
    ]);
  });

  it.each([
    [
      "clips",
      "post",
      "/streams/{streamId}/clips",
      { recordingId: "recording_1", interval: { kind: "last", seconds: 10 } },
      202,
    ],
    ["clips", "delete", "/clips/{clipId}", undefined, 202],
    ["mixers", "post", "/broadcasts/{broadcastId}/mixers", undefined, 201],
    [
      "mixers",
      "post",
      "/mixers/{mixerId}/activate-scene",
      { version: 1, sceneId: "scene_1", sceneVersion: 1 },
      202,
    ],
    ["mixers", "post", "/mixers/{mixerId}/stop", { version: 1 }, 202],
    [
      "dvr",
      "post",
      "/streams/{streamId}/dvr-policy",
      { policy: { enabled: false, consentAcknowledged: true } },
      201,
    ],
    [
      "guests",
      "post",
      "/streams/{streamId}/audience-grants",
      { subject: "viewer_1", name: "Viewer" },
      201,
    ],
    ["guests", "post", "/streams/{streamId}/guests/{guestId}/join-grant", { version: 1 }, 201],
  ] as const)(
    "matches %s %s %s success status after request validation",
    async (slice, method, path, body, expected) => {
      const registered = await registeredRoutes(sourceFiles[slice]);
      const route = registered.find((r) => r.method === method && r.path === path);
      if (!route) throw new Error(`Unregistered ${method} ${path}`);
      let status = 200;
      const reply: Reply = {
        code(value) {
          status = value;
          return this;
        },
        send(value) {
          return value;
        },
      };
      await route.handler({ body, headers: {}, params: {}, query: {} }, reply);
      expect(status).toBe(expected);
      expect(documents[slice].paths[path]?.[method]?.responses[String(status)]).toBeDefined();
    },
  );
});
