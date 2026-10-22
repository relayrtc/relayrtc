import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type {
  ServiceUsageCoverage,
  ServiceUsageMetric,
  ServiceUsageResource,
} from "@relayrtc/types";
import { serviceUsageDefinitions } from "@relayrtc/types";
import type { Transaction } from "./repository.js";

export interface ServiceUsageOwner {
  organizationId?: string;
  projectId: string;
  environmentId: string;
  streamId: string;
  resourceType: ServiceUsageResource;
  resourceId: string;
  runId: string;
}
export const usageIdentity = (identity: string) =>
  createHash("sha256").update(identity).digest("hex");
export async function observeServiceUsage(
  db: Transaction,
  owner: ServiceUsageOwner,
  identity: string,
  metrics: Partial<Record<ServiceUsageMetric, number>>,
  startedAt: Date,
  endedAt: Date,
  coverage: ServiceUsageCoverage,
  counters: Record<string, number> = {},
  actorKey: string | null = null,
) {
  if (
    endedAt < startedAt ||
    Object.entries(metrics).some(
      ([key, value]) => !(key in serviceUsageDefinitions) || !Number.isFinite(value) || value < 0,
    )
  )
    throw new Error("INVALID_SERVICE_USAGE_OBSERVATION");
  await db.execute(sql`INSERT INTO service_usage_sample(id,organization_id,project_id,environment_id,resource_type,resource_id,stream_id,run_id,actor_key,metrics,counters,started_at,ended_at,occurred_at,coverage)
    VALUES(${usageIdentity(identity)},coalesce(${owner.organizationId ?? null},(SELECT organization_id FROM streaming_stream WHERE id=${owner.streamId})),${owner.projectId},${owner.environmentId},${owner.resourceType},${owner.resourceId},${owner.streamId},${owner.runId},${actorKey},${JSON.stringify(metrics)}::jsonb,${JSON.stringify(counters)}::jsonb,${startedAt.toISOString()},${endedAt.toISOString()},${endedAt.toISOString()},${coverage}) ON CONFLICT DO NOTHING`);
}

export async function openUsageObject(db: Transaction, recordingId: string, name: string) {
  await db.execute(sql`INSERT INTO service_usage_object(id,organization_id,project_id,environment_id,resource_type,resource_id,stream_id,size_bytes,opened_at)
    SELECT r.id||':'||o.name,s.organization_id,r.project_id,r.environment_id,CASE WHEN r.kind='buffer' THEN 'dvr' ELSE r.kind END,r.id,r.stream_id,o.size_bytes,o.committed_at
    FROM recording_object o JOIN recording r ON r.id=o.recording_id JOIN streaming_stream s ON s.id=r.stream_id WHERE r.id=${recordingId} AND o.name=${name} AND o.committed_at IS NOT NULL ON CONFLICT DO NOTHING`);
}
export async function closeUsageObject(db: Transaction, recordingId: string, name: string) {
  await db.execute(
    sql`UPDATE service_usage_object SET removed_at=clock_timestamp() WHERE id=${`${recordingId}:${name}`} AND removed_at IS NULL`,
  );
}

export async function correctServiceUsage(
  db: Transaction,
  identity: string,
  expectedRevision: number,
  metrics: Partial<Record<ServiceUsageMetric, number>>,
  coverage: ServiceUsageCoverage,
  actorId: string,
  reason: "counter_reconciliation" | "delivery_reconciliation",
) {
  if (
    !actorId ||
    actorId.length > 128 ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    Object.entries(metrics).some(
      ([key, value]) => !(key in serviceUsageDefinitions) || !Number.isFinite(value) || value < 0,
    )
  )
    throw new Error("INVALID_SERVICE_USAGE_CORRECTION");
  const [current] = await db.execute(
    sql`SELECT metrics,coverage,revision FROM service_usage_sample WHERE id=${usageIdentity(identity)} FOR UPDATE`,
  );
  if (current?.revision !== expectedRevision)
    throw new Error("SERVICE_USAGE_CORRECTION_CONFLICT");
  const history = {
    revision: expectedRevision,
    actorId,
    reason,
    correctedAt: new Date().toISOString(),
    metrics: current.metrics,
    coverage: current.coverage,
  };
  await db.execute(
    sql`UPDATE service_usage_sample SET metrics=${JSON.stringify(metrics)}::jsonb,coverage=${coverage},revision=revision+1,corrections=corrections||jsonb_build_array(${JSON.stringify(history)}::jsonb) WHERE id=${usageIdentity(identity)} AND revision=${expectedRevision}`,
  );
}

export function recordingUsageOwner(r: {
  id: string;
  kind: string;
  project_id: string;
  environment_id: string;
  stream_id: string;
  fence: number;
}): ServiceUsageOwner {
  return {
    projectId: r.project_id,
    environmentId: r.environment_id,
    streamId: r.stream_id,
    resourceId: r.id,
    resourceType: r.kind === "buffer" ? "dvr" : r.kind === "clip" ? "clip" : "recording",
    runId: `${r.id}:${String(r.fence)}`,
  };
}

export async function observeRecordingProcessing(
  db: Transaction,
  r: Parameters<typeof recordingUsageOwner>[0] & {
    state: string;
    heartbeat_at: Date | null;
    leased_until: Date | null;
  },
  end = new Date(),
) {
  if (r.state !== "finalizing" || !r.heartbeat_at || !r.leased_until) return 0;
  const stop = new Date(
    Math.min(end.getTime(), r.leased_until.getTime(), r.heartbeat_at.getTime() + 15000),
  );
  const seconds = Math.max(0, (stop.getTime() - r.heartbeat_at.getTime()) / 1000);
  if (seconds > 0)
    await observeServiceUsage(
      db,
      recordingUsageOwner(r),
      `finalize:${r.id}:${String(r.fence)}:${r.heartbeat_at.toISOString()}`,
      { [r.kind === "clip" ? "clipProcessingSeconds" : "recordingProcessingSeconds"]: seconds },
      r.heartbeat_at,
      stop,
      end.getTime() - r.heartbeat_at.getTime() <= 15000 ? "observed" : "partial",
    );
  return seconds;
}
