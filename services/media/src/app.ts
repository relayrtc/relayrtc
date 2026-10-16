import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { MediaConfig } from "./config/environment.js";
import type { MediaEngine } from "./engine/media-engine.js";
import { healthRoutes } from "./routes/health.js";
import { mediaRoutes } from "./routes/media.js";
import { streamingMediaRoutes } from "./routes/streaming.js";

interface BuildAppOptions {
  qualityDelivery?: () => Record<string, number>;
  config: MediaConfig;
  engine?: MediaEngine;
}

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

export const buildApp = (options: BuildAppOptions): FastifyInstance => {
  const app = Fastify({
    bodyLimit: 1_048_576,
    connectionTimeout: 10_000,
    genReqId: (request) => {
      const requestId = request.headers["x-request-id"];
      return typeof requestId === "string" && requestIdPattern.test(requestId)
        ? requestId
        : randomUUID();
    },
    logger: {
      level: options.config.logLevel,
      redact: {
        censor: "[REDACTED]",
        paths: ["req.headers.authorization", "request.headers.authorization"],
      },
    },
    requestIdHeader: "x-request-id",
    requestTimeout: 10_000,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  if (options.engine) {
    app.addHook("onClose", async () => options.engine?.close());
  }

  void app.register(healthRoutes, {
    ...(options.qualityDelivery ? { qualityDelivery: options.qualityDelivery } : {}),
    nodeId: options.config.nodeId,
    ...(options.engine ? { engine: options.engine } : {}),
  });
  if (options.engine) {
    void app.register(mediaRoutes, {
      engine: options.engine,
      internalSecret: options.config.internalSecret,
      prefix: "/internal/v1",
    });
    void app.register(streamingMediaRoutes, {
      engine: options.engine,
      internalSecret: options.config.internalSecret,
      prefix: "/internal/v1",
    });
  }

  return app;
};
