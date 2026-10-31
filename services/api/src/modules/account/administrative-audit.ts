import { recordAudit, type AuditActor } from "@relayrtc/auth/server";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest { administrativeAuditRecorded: boolean }
}

export function registerAdministrativeAudit(app: FastifyInstance, database: RelayKitDatabase) {
  app.decorateRequest("administrativeAuditRecorded", false);
  const context = async (request: FastifyRequest) => {
    const key = request.apiKey ?? (request.webhookPrincipal?.type === "apiKey" ? request.webhookPrincipal.key : null);
    let actor: AuditActor = { type: "ANONYMOUS", name: "Unauthenticated API request" };
    let organizationId: string | null = null;
    if (key) {
      const [record] = await database.select({ name: schema.apiKey.name, organizationId: schema.project.organizationId })
        .from(schema.apiKey).innerJoin(schema.project, eq(schema.project.id, schema.apiKey.projectId)).where(eq(schema.apiKey.id, key.keyId));
      actor = { type: "API_KEY", id: key.keyId, name: record?.name ?? "API key" };
      organizationId = record?.organizationId ?? null;
    } else if (request.webhookPrincipal?.type === "session") {
      const [user] = await database.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, request.webhookPrincipal.userId));
      actor = { type: "USER", id: request.webhookPrincipal.userId, name: user?.name ?? "User" };
      const params = request.params as { projectId?: string };
      if (params.projectId) {
        const [project] = await database.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, params.projectId));
        organizationId = project?.organizationId ?? null;
      }
    }
    return { actor, organizationId };
  };
  // Record the final API outcome before sending the response. Transactional
  // database triggers separately retain committed resource changes.
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/v1/") || ["GET", "HEAD", "OPTIONS"].includes(request.method) || request.administrativeAuditRecorded) return payload;
    request.administrativeAuditRecorded = true;
    const scope = await context(request);
    const params = request.params as { roomId?: string; participantId?: string };
    let roomId: string | null = null;
    if (request.apiKey && params.roomId) {
      const [room] = await database.select({ id: schema.room.id }).from(schema.room).where(and(
        eq(schema.room.id, params.roomId), eq(schema.room.projectId, request.apiKey.projectId), eq(schema.room.environmentId, request.apiKey.environmentId)));
      roomId = room?.id ?? null;
    }
    await recordAudit(database, { ...scope, roomId, resourceId: roomId ? params.participantId ?? roomId : null, resourceType: "api_request", action: `${request.method} ${request.routeOptions.url ?? "unknown"}`,
      outcome: reply.statusCode < 400 ? "SUCCESS" : "FAILURE", correlationId: request.id,
      metadata: { status: reply.statusCode, method: request.method } });
    return payload;
  });
}
