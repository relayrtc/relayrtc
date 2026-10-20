import { sql } from "drizzle-orm";
import type { ServiceUsageCoverage, ServiceUsageMetric } from "@relayrtc/types";
import type { Transaction, SessionRow, StreamRow } from "./repository.js";
import { observeServiceUsage } from "./service-usage.js";

export async function observeSourceWork(
  db: Transaction,
  session: SessionRow,
  stream: StreamRow,
  sequence: number,
  processing: { encodedSeconds: number; composedFrames: number } | undefined,
  metrics: Partial<Record<ServiceUsageMetric, number>>,
  start: Date,
  end: Date,
  coverage: ServiceUsageCoverage,
) {
  const runId = `${session.id}:${String(session.generation)}`;
  const [last] = await db.execute(
    sql`SELECT counters FROM service_usage_sample WHERE resource_type='stream' AND resource_id=${stream.id} AND run_id=${runId} AND counters ? 'encodedSeconds' ORDER BY ended_at DESC LIMIT 1`,
  );
  const previous = last?.counters as
    { encodedSeconds?: number; composedFrames?: number } | undefined;
  const encodedReset = processing && processing.encodedSeconds < (previous?.encodedSeconds ?? 0);
  const framesReset = processing && processing.composedFrames < (previous?.composedFrames ?? 0);
  if (processing) {
    metrics.sourceEncodeSeconds = Math.max(
      0,
      processing.encodedSeconds - (encodedReset ? 0 : (previous?.encodedSeconds ?? 0)),
    );
    metrics.sourceComposeFrames = Math.max(
      0,
      processing.composedFrames - (framesReset ? 0 : (previous?.composedFrames ?? 0)),
    );
    metrics.sourceRemuxSeconds = 0;
  }
  await observeServiceUsage(
    db,
    { ...stream, streamId: stream.id, resourceId: stream.id, resourceType: "stream", runId },
    `source:${runId}:${String(sequence)}`,
    metrics,
    start,
    end,
    !processing || encodedReset || framesReset ? "partial" : coverage,
    processing ?? {},
  );
}
