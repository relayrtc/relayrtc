import { recordAudit, type AuditActor } from "@relayrtc/auth/server";
import { schema } from "@relayrtc/database";
import { createWebhookSecretVault } from "@relayrtc/protocol/webhook-security";
import { resolveEgressDestination } from "@relayrtc/protocol/egress-security";
import type { StreamDestination } from "@relayrtc/types";
import { sql } from "drizzle-orm";
import type { StreamingConfig } from "./config.js";
import { ApiError } from "../../http/errors/api-error.js";
import { id, type Transaction, type StreamRow } from "./repository.js";

export type DestinationRow = typeof schema.streamDestination.$inferSelect;
export function publicDestination(row: DestinationRow): StreamDestination {
  return {
    id: row.id,
    streamId: row.streamId,
    name: row.name,
    host: row.host,
    protocol: row.protocol as "rtmp" | "rtmps",
    port: row.port,
    profile: row.profile as StreamDestination["profile"],
    enabled: row.enabled,
    version: row.version,
    credentialVersion: row.credentialVersion,
    secretConfigured: !!row.encryptedSecret,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function destinationVault(config: StreamingConfig) {
  if (!config.destinationEncryptionKey)
    throw new ApiError(
      503,
      "DESTINATION_ENCRYPTION_UNAVAILABLE",
      "Configure STREAMING_DESTINATION_ENCRYPTION_KEY before adding destinations.",
    );
  return createWebhookSecretVault(config.destinationEncryptionKey);
}
export const destinationContext = (id: string, version: number) =>
  `streaming-destination:${id}:${String(version)}`;
export async function checkDestination(endpoint: string) {
  try {
    return await resolveEgressDestination(endpoint);
  } catch {
    throw new ApiError(
      400,
      "DESTINATION_ADDRESS_REJECTED",
      "The destination must resolve exclusively to public addresses on port 1935, 1936 or 443.",
    );
  }
}
export async function destinationAudit(
  db: Transaction,
  stream: StreamRow,
  actor: AuditActor,
  action: string,
  destinationId: string,
  correlationId: string,
) {
  await recordAudit(db, {
    actor,
    action,
    outcome: "SUCCESS",
    organizationId: stream.organizationId,
    resourceType: "destination",
    resourceId: destinationId,
    correlationId,
  });
}
export async function destinationEvent(
  db: Transaction,
  scope: { projectId: string; environmentId: string; streamId: string },
  type: string,
  data: {
    destinationId: string;
    broadcastId?: string;
    outputId?: string;
    fence?: number;
    reason?: string | null;
    correlationId?: string | null;
  },
) {
  const eventId = id("event"),
    occurredAt = new Date().toISOString();
  const payload = {
    id: eventId,
    type,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    occurredAt,
    data: { streamId: scope.streamId, ...data },
  };
  const body = JSON.stringify(payload);
  await db.execute(
    sql`INSERT INTO webhook_event(id,source_key,project_id,environment_id,event_type,occurred_at,payload,body) VALUES(${eventId},${eventId},${scope.projectId},${scope.environmentId},${type},${occurredAt},${body}::jsonb,${body})`,
  );
}
