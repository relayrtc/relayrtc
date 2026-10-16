import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { verifyStreamingGrant, streamingSecretHash } from "@relayrtc/protocol/streaming-control";
import { streamingIdSchema } from "@relayrtc/validation";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../../http/errors/api-error.js";
import { validate } from "../../http/validation/validate.js";
import type { StreamingConfig } from "./config.js";
import { StreamingGateway, ingestPath, programPath } from "./gateway.js";
import { startSession, stopSessions } from "./lifecycle.js";
import { conflict, getStream, type Transaction } from "./repository.js";
import { equalSecret } from "./runtime-routes.js";
import { boundedBody } from "./store.js";

const denied = () =>
  new ApiError(
    401,
    "INGEST_AUTHENTICATION_FAILED",
    "This ingest credential is invalid, expired, or revoked",
  );
async function credential(db: Transaction, streamId: string, value: string) {
  const [row] =
    await db.execute(sql`SELECT c.id FROM streaming_ingest_credential c JOIN streaming_stream t ON t.id=c.stream_id
    JOIN environment e ON e.id=t.environment_id AND e.project_id=t.project_id JOIN project p ON p.id=t.project_id JOIN organization o ON o.id=t.organization_id
    WHERE c.stream_id=${streamId} AND c.secret_hash=${streamingSecretHash(value)} AND c.revoked_at IS NULL AND c.expires_at>now()
    AND t.status='active' AND e.status='active' AND p.status='active' AND o.status='active' FOR SHARE OF c,e,p,o`);
  if (!row) throw denied();
  return String(row.id);
}
const authSchema = z.object({
  user: z.string().max(4096).default(""),
  password: z.string().max(4096).default(""),
  token: z.string().max(4096).default(""),
  action: z.string().max(32),
  path: z.string().max(256).default(""),
  protocol: z.string().max(32).default(""),
  id: z
    .string()
    .max(128)
    .nullish()
    .transform((value) => value ?? ""),
  query: z.string().max(4096).default(""),
});
export const ingestRoutes: FastifyPluginAsync<{
  database: RelayKitDatabase;
  config: StreamingConfig;
}> = (app, { database, config }) => {
  const gateway = new StreamingGateway(config);
  app.addContentTypeParser(
    ["application/sdp", "application/trickle-ice-sdpfrag"],
    { parseAs: "string", bodyLimit: 131072 },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin) {
      if (!config.allowedOrigins.includes(request.headers.origin))
        throw new ApiError(403, "ORIGIN_FORBIDDEN", "This ingest origin is not allowed");
      reply
        .header("access-control-allow-origin", request.headers.origin)
        .header("vary", "Origin")
        .header("access-control-expose-headers", "Location,ETag,Accept-Patch,Link");
    }
  });
  app.post("/internal/v1/streaming/gateway-auth", async (request, reply) => {
    const basic = /^Basic (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
    const password = basic
      ? Buffer.from(basic, "base64").toString().split(":").slice(1).join(":")
      : "";
    if (!equalSecret(password, config.gatewayKey)) throw denied();
    const input = validate(authSchema, request.body),
      token = input.token || input.password;
    if (input.action === "metrics" && equalSecret(token, config.gatewayKey))
      return reply.code(204).send();
    const claims = verifyStreamingGrant(config.secret, token, "streaming-gateway");
    if (claims?.action === "api" && claims.sub === "api" && input.action === "api")
      return reply.code(204).send();
    if (claims) {
      await database.transaction(async (db) => {
        const [session] = await db
          .select()
          .from(schema.streamingSession)
          .where(eq(schema.streamingSession.id, claims.sessionId));
        if (
          session?.streamId !== claims.streamId ||
          session.generation !== claims.generation ||
          session.desiredState !== "running" ||
          !session.leasedUntil ||
          session.leasedUntil.getTime() <= Date.now()
        )
          throw denied();
        const stream = await getStream(db, session.streamId);
        if (stream.status !== "active") throw denied();
        const isOrigin =
          claims.sub === "origin" && claims.action === "read" && input.protocol === "hls";
        if (!isOrigin && claims.sub !== session.leaseToken) throw denied();
        const path =
          claims.action === "publish" || isOrigin
            ? programPath(session.id, session.generation)
            : ingestPath(stream.id);
        if (
          input.action !== claims.action ||
          input.path !== path ||
          (!isOrigin && input.protocol !== "rtsp")
        )
          throw denied();
      });
      return reply.code(204).send();
    }
    if (
      input.action !== "publish" ||
      !["rtmp", "webrtc"].includes(input.protocol) ||
      !input.path.startsWith("ingest_") ||
      !input.id
    )
      throw denied();
    const streamId = validate(streamingIdSchema, input.path.slice(7));
    const value = token || (new URLSearchParams(input.query).get("pass") ?? "");
    await database.transaction(async (db) => {
      const credentialId = await credential(db, streamId, value),
        stream = await getStream(db, streamId, true);
      if (stream.source.kind !== (input.protocol === "webrtc" ? "whip" : "rtmp")) throw denied();
      await startSession(db, stream, config, {
        id: input.id,
        type: input.protocol === "webrtc" ? "webRTCSession" : "rtmpConn",
        credentialId,
      });
    });
    return reply.code(204).send();
  });
  for (const path of ["/v1/ingest/whip/:streamId", "/v1/ingest/whip/:streamId/:sessionId"])
    app.options(path, async (_request, reply) =>
      reply
        .header("access-control-allow-methods", "POST,PATCH,DELETE,OPTIONS")
        .header("access-control-allow-headers", "Authorization,Content-Type,If-Match")
        .header("accept-post", "application/sdp")
        .header("accept-patch", "application/trickle-ice-sdpfrag")
        .code(204)
        .send(),
    );
  app.post("/v1/ingest/whip/:streamId", async (request, reply) => {
    const { streamId } = validate(z.object({ streamId: streamingIdSchema }), request.params);
    if (
      typeof request.body !== "string" ||
      request.headers["content-type"]?.split(";")[0] !== "application/sdp"
    )
      throw new ApiError(415, "SDP_REQUIRED", "Send an SDP offer with application/sdp");
    const value = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
    await database.transaction(async (db) => {
      await credential(db, streamId, value);
      const stream = await getStream(db, streamId);
      if (stream.source.kind !== "whip") throw denied();
    });
    await gateway.ensurePath(ingestPath(streamId));
    const target = `${config.gatewayWhip}/${ingestPath(streamId)}/whip`;
    const response = await fetch(target, {
      method: "POST",
      headers: { authorization: `Bearer ${value}`, "content-type": "application/sdp" },
      body: request.body,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      throw conflict(
        "WHIP_ADMISSION_FAILED",
        "WHIP negotiation failed or another publisher owns this stream",
      );
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("WHIP_LOCATION_MISSING");
    const resource = new URL(location, target);
    if (
      resource.origin !== new URL(config.gatewayWhip).origin ||
      !resource.pathname.startsWith(`/${ingestPath(streamId)}/whip/`) ||
      resource.search ||
      resource.hash
    )
      throw new Error("INVALID_WHIP_LOCATION");
    const sessionId = await database.transaction(async (db) => {
      const credentialId = await credential(db, streamId, value);
      const [session] = await db.execute<{ id: string }>(
        sql`UPDATE streaming_session SET whip_resource=${resource.pathname} WHERE stream_id=${streamId} AND ingress_credential_id=${credentialId} AND desired_state='running' AND state NOT IN ('ended','failed') RETURNING id`,
      );
      if (!session) throw denied();
      return session.id;
    });
    reply
      .header("location", `${config.publicOrigin}/v1/ingest/whip/${streamId}/${sessionId}`)
      .header("accept-patch", "application/trickle-ice-sdpfrag");
    if (response.headers.get("etag")) reply.header("etag", required(response.headers.get("etag")));
    if (response.headers.get("link")) reply.header("link", required(response.headers.get("link")));
    return reply
      .type("application/sdp")
      .code(201)
      .send((await boundedBody(response, 131072)).toString());
  });
  for (const method of ["PATCH", "DELETE"] as const)
    app.route({
      method,
      url: "/v1/ingest/whip/:streamId/:sessionId",
      handler: async (request, reply) => {
        const { streamId, sessionId } = validate(
          z.object({ streamId: streamingIdSchema, sessionId: streamingIdSchema }),
          request.params,
        );
        const value = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
        const resource = await database.transaction(async (db) => {
          const credentialId = await credential(db, streamId, value);
          const [session] = await db.execute<{ whip_resource: string | null }>(
            sql`SELECT whip_resource FROM streaming_session WHERE id=${sessionId} AND stream_id=${streamId} AND ingress_credential_id=${credentialId} AND desired_state='running' AND state NOT IN ('ended','failed')`,
          );
          if (!session?.whip_resource)
            throw new ApiError(410, "WHIP_SESSION_GONE", "The WHIP session has ended");
          return session.whip_resource;
        });
        if (
          method === "PATCH" &&
          (typeof request.body !== "string" ||
            request.headers["content-type"]?.split(";")[0] !== "application/trickle-ice-sdpfrag")
        )
          throw new ApiError(415, "ICE_FRAGMENT_REQUIRED", "Send application/trickle-ice-sdpfrag");
        const response = await fetch(`${config.gatewayWhip}${resource}`, {
          method,
          headers: {
            authorization: `Bearer ${value}`,
            "content-type": "application/trickle-ice-sdpfrag",
            ...(request.headers["if-match"] ? { "if-match": request.headers["if-match"] } : {}),
          },
          ...(method === "PATCH" ? { body: request.body as string } : {}),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (method === "DELETE" && (response.ok || response.status === 404))
          await database.transaction((db) => stopSessions(db, streamId));
        if (response.headers.get("etag"))
          reply.header("etag", required(response.headers.get("etag")));
        const body = await boundedBody(response, 131072);
        return reply
          .code(response.status)
          .type(response.headers.get("content-type") ?? "application/octet-stream")
          .send(body);
      },
    });
  return Promise.resolve();
};

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
