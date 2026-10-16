import { verifyStreamingGrant, streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { MediaEngine } from "../engine/media-engine.js";

const exportSchema = z
  .object({
    exportId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/u),
    roomId: z.string().max(128),
    receiverIp: z.ipv4(),
    ports: z
      .array(z.number().int().min(10000).max(65000).multipleOf(2))
      .min(1)
      .max(12)
      .refine((p) => new Set(p).size === p.length),
    videoTrackIds: z.array(z.string().max(128)).max(4),
    audioTrackIds: z.array(z.string().max(128)).max(8),
    audioOnly: z.boolean(),
    layout: z.enum(["single", "grid"]),
  })
  .strict();
const controlSchema = z
  .object({
    exportId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/u),
    action: z.enum(["resume", "renew", "close"]),
  })
  .strict();
export const streamingMediaRoutes: FastifyPluginAsync<{
  engine: MediaEngine;
  internalSecret: string;
}> = (app, options) => {
  app.addHook("preHandler", async (request, reply) => {
    const token = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const grant = verifyStreamingGrant(options.internalSecret, token, "streaming-media");
    const body = request.body as { exportId?: string } | undefined;
    if (
      grant?.action !== streamingSecretHash(JSON.stringify(request.body)) ||
      body?.exportId !== `${grant.sessionId}_${String(grant.generation)}`
    ) {
      return reply.code(401).send({ code: "INVALID_STREAMING_EXPORT_AUTHORITY" });
    }
  });
  app.post("/streaming/exports", async (request, reply) => {
    const parsed = exportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_STREAMING_EXPORT" });
    if (!options.engine.createStreamingExport)
      return reply.code(503).send({ code: "STREAMING_EXPORT_UNAVAILABLE" });
    try {
      return await options.engine.createStreamingExport(parsed.data);
    } catch {
      return reply.code(409).send({ code: "STREAMING_EXPORT_REJECTED" });
    }
  });
  app.post("/streaming/exports/control", async (request, reply) => {
    const parsed = controlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_STREAMING_EXPORT" });
    if (!options.engine.controlStreamingExport)
      return reply.code(503).send({ code: "STREAMING_EXPORT_UNAVAILABLE" });
    try {
      return await options.engine.controlStreamingExport(parsed.data.exportId, parsed.data.action);
    } catch {
      return reply.code(409).send({ code: "STREAMING_EXPORT_EXPIRED" });
    }
  });
  return Promise.resolve();
};
