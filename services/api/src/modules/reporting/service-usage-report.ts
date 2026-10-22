import type { RelayKitDatabase } from "@relayrtc/database";
import { z } from "zod";
import { serviceUsageDefinitions, serviceUsageRules } from "@relayrtc/types";
import {
  serviceUsageQuerySchema,
  serviceUsageReportSchema,
  type ServiceUsageQuery,
  type ServiceUsageReport,
} from "@relayrtc/validation";
import { sql } from "drizzle-orm";
import { ApiError } from "../../http/errors/api-error.js";

export interface ServiceUsageScope {
  organizationId: string;
  projectId: string | null;
  environmentId: string | null;
  resourceType?: string;
  resourceId?: string;
  resourceIds?: string[];
  streamId?: string;
}
type Executor = Pick<RelayKitDatabase, "execute">;
export function serviceUsageWindow(input: ServiceUsageQuery, now = new Date()) {
  const q = serviceUsageQuerySchema.parse(input);
  const endedAt = q.endedAt ? new Date(q.endedAt) : now;
  const duration =
    q.range === "live"
      ? 900000
      : (q.range === "24h" ? 1 : q.range === "14d" ? 14 : q.range === "30d" ? 30 : 7) * 86400000;
  const startedAt = q.startedAt ? new Date(q.startedAt) : new Date(endedAt.getTime() - duration);
  if (
    endedAt > now ||
    endedAt <= startedAt ||
    endedAt.getTime() - startedAt.getTime() > 30 * 86400000
  )
    throw new ApiError(
      400,
      "USAGE_WINDOW_INVALID",
      "Choose a positive UTC window of at most 30 days, ending no later than now.",
    );
  return {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    granularity:
      q.granularity ?? (endedAt.getTime() - startedAt.getTime() <= 86400000 ? "hour" : "day"),
  };
}

export async function getServiceUsage(
  database: Executor,
  scope: ServiceUsageScope,
  input: ServiceUsageQuery,
  now = new Date(),
): Promise<ServiceUsageReport> {
  const window = serviceUsageWindow(input, now);
  const filter = sql`organization_id=${scope.organizationId}
    ${scope.projectId ? sql`AND project_id=${scope.projectId}` : sql``}
    ${scope.environmentId ? sql`AND environment_id=${scope.environmentId}` : sql``}
    ${scope.streamId ? sql`AND stream_id=${scope.streamId}` : sql``}
    ${scope.resourceType ? sql`AND resource_type=${scope.resourceType}` : sql``}
    ${scope.resourceId ? sql`AND resource_id=${scope.resourceId}` : sql``}
    ${
      scope.resourceIds
        ? sql`AND resource_id IN (${sql.join(
            scope.resourceIds.map((value) => sql`${value}`),
            sql`,`,
          )})`
        : sql``
    }`;
  const rows = await database.execute(sql`
    WITH bounds AS (SELECT ${window.startedAt}::timestamptz lo,${window.endedAt}::timestamptz hi),
    observations AS (SELECT s.* FROM service_usage_sample s,bounds WHERE ${filter} AND s.started_at<hi AND s.ended_at>=lo),
    objects AS (SELECT o.* FROM service_usage_object o,bounds WHERE ${filter} AND o.opened_at<hi AND coalesce(o.removed_at,hi)>=lo),
    inventory AS (SELECT DISTINCT resource_type,resource_id,stream_id FROM observations UNION SELECT DISTINCT resource_type,resource_id,stream_id FROM objects),
    selected_resources AS (SELECT * FROM inventory ORDER BY resource_type,resource_id LIMIT 100),
    windows AS (
      SELECT 'summary'::text key,lo starts,hi ends,NULL::text resource_type,NULL::text resource_id,NULL::text stream_id,NULL::text project_id FROM bounds
      UNION ALL SELECT 'bucket:'||b::text,greatest(lo,b),least(hi,b+${`1 ${window.granularity}`}::interval),NULL,NULL,NULL,NULL
        FROM bounds,LATERAL generate_series(date_trunc(${window.granularity},lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',hi,${`1 ${window.granularity}`}::interval) b WHERE b<hi
      UNION ALL SELECT 'resource:'||resource_type||':'||resource_id,lo,hi,resource_type,resource_id,stream_id,NULL FROM selected_resources,bounds
      UNION ALL SELECT 'project:'||project_id,lo,hi,NULL,NULL,NULL,project_id FROM (SELECT DISTINCT project_id FROM observations UNION SELECT DISTINCT project_id FROM objects) projects,bounds
    ),
    definitions AS (SELECT key metric,value->>'attribution' attribution FROM jsonb_each(${JSON.stringify(serviceUsageDefinitions)}::jsonb)),
    values_by_window AS (
      SELECT w.key,e.key metric,
        sum(CASE WHEN d.attribution='interval' THEN coalesce(e.value::float8 * extract(epoch FROM least(s.ended_at,w.ends)-greatest(s.started_at,w.starts))/nullif(extract(epoch FROM s.ended_at-s.started_at),0),0)
          ELSE e.value::float8 END)::float8 value,
        CASE WHEN bool_or(s.coverage IN ('partial','unavailable')) THEN 'partial' WHEN e.key='viewerSeconds' OR bool_or(s.coverage='estimated') THEN 'estimated' ELSE 'observed' END coverage
      FROM windows w JOIN observations s ON (w.project_id IS NULL OR w.project_id=s.project_id) AND (w.resource_id IS NULL OR (s.resource_id=w.resource_id AND s.resource_type=w.resource_type))
      CROSS JOIN LATERAL jsonb_each_text(s.metrics) e JOIN definitions d ON d.metric=e.key
      WHERE (d.attribution='interval' AND s.started_at<w.ends AND s.ended_at>w.starts)
        OR (d.attribution='event' AND s.occurred_at>=w.starts AND s.occurred_at<w.ends)
      GROUP BY w.key,e.key
      UNION ALL
      SELECT w.key,CASE o.resource_type WHEN 'clip' THEN 'clipStorageByteSeconds' WHEN 'dvr' THEN 'bufferStorageByteSeconds' ELSE 'recordingStorageByteSeconds' END,
        sum(o.size_bytes*greatest(0,extract(epoch FROM least(coalesce(o.removed_at,w.ends),w.ends)-greatest(o.opened_at,w.starts)) ))::float8,'observed'
      FROM windows w JOIN objects o ON (w.project_id IS NULL OR w.project_id=o.project_id) AND (w.resource_id IS NULL OR (o.resource_id=w.resource_id AND o.resource_type=w.resource_type)) AND o.opened_at<w.ends AND coalesce(o.removed_at,w.ends)>w.starts GROUP BY w.key,o.resource_type
      UNION ALL
      SELECT w.key,CASE o.resource_type WHEN 'clip' THEN 'clipStoredBytes' WHEN 'dvr' THEN 'bufferStoredBytes' ELSE 'recordingStoredBytes' END,
        sum(o.size_bytes)::float8,'observed'
      FROM windows w JOIN objects o ON (w.project_id IS NULL OR w.project_id=o.project_id) AND (w.resource_id IS NULL OR (o.resource_id=w.resource_id AND o.resource_type=w.resource_type)) AND o.opened_at<w.ends AND (o.removed_at IS NULL OR o.removed_at>=w.ends) GROUP BY w.key,o.resource_type
    ),
    viewer_edges AS (
      SELECT w.key,greatest(s.started_at,w.starts) at,1 delta FROM windows w JOIN observations s ON (w.project_id IS NULL OR w.project_id=s.project_id) AND s.started_at<w.ends AND s.ended_at>w.starts AND (w.resource_id IS NULL OR (s.resource_id=w.resource_id AND s.resource_type=w.resource_type)) WHERE (s.metrics->>'viewerSeconds')::float8>0
      UNION ALL
      SELECT w.key,least(s.ended_at,w.ends),-1 FROM windows w JOIN observations s ON (w.project_id IS NULL OR w.project_id=s.project_id) AND s.started_at<w.ends AND s.ended_at>w.starts AND (w.resource_id IS NULL OR (s.resource_id=w.resource_id AND s.resource_type=w.resource_type)) WHERE (s.metrics->>'viewerSeconds')::float8>0
    ),
    viewer_peaks AS (SELECT key,max(active)::float8 value FROM (SELECT key,sum(sum(delta)) OVER (PARTITION BY key ORDER BY at) active FROM viewer_edges GROUP BY key,at) a GROUP BY key),
    values_complete AS (SELECT * FROM values_by_window UNION ALL SELECT key,'peakConcurrentViewers',value,'estimated' FROM viewer_peaks)
    SELECT w.*,
      coalesce((SELECT jsonb_object_agg(metric,value) FROM values_complete v WHERE v.key=w.key),'{}'::jsonb) metrics,
      coalesce((SELECT jsonb_object_agg(metric,coverage) FROM values_complete v WHERE v.key=w.key),'{}'::jsonb) coverage,
      (SELECT started_at FROM service_usage_activation WHERE id='streaming-v1') journal_started_at,
      (SELECT retained_from FROM service_usage_activation WHERE id='streaming-v1') retained_from,
      (SELECT count(*)>100 FROM inventory) truncated
    FROM windows w ORDER BY w.starts,w.key
  `);
  const empty = () => Object.fromEntries(Object.keys(serviceUsageDefinitions).map((k) => [k, 0]));
  const summary = rows.find((r) => r.key === "summary");
  const activation = z.coerce
    .date()
    .parse(summary?.journal_started_at ?? window.endedAt)
    .toISOString();
  const historicalCoverage = window.startedAt < activation ? "partial" : "complete";
  if (summary?.retained_from) {
    const retainedFrom = z.coerce.date().parse(summary.retained_from).toISOString();
    if (window.startedAt < retainedFrom)
      throw new ApiError(400, "USAGE_HISTORY_EXPIRED", "Select a window within retained service history.");
  }
  const coverageFor = (row: typeof summary) =>
    Object.fromEntries(
      Object.keys(serviceUsageDefinitions).map((name) => {
        if (window.endedAt <= activation) return [name, "unavailable"];
        const value = (row?.coverage as Record<string, string> | undefined)?.[name];
        const storage = /Stor(?:ed|age)/u.test(name);
        return [
          name,
          historicalCoverage === "partial"
            ? value || storage
              ? "partial"
              : "unavailable"
            : (value ?? (storage ? "observed" : "unavailable")),
        ];
      }),
    );
  const coverage = coverageFor(summary);
  return serviceUsageReportSchema.parse({
    window: { ...window, timezone: "UTC", endExclusive: true },
    summary: { ...empty(), ...(summary?.metrics as object) },
    metricDefinitions: serviceUsageDefinitions,
    rules: serviceUsageRules,
    buckets: rows
      .filter((r) => String(r.key).startsWith("bucket:"))
      .map((r) => ({
        startedAt: new Date(String(r.starts)).toISOString(),
        endedAt: new Date(String(r.ends)).toISOString(),
        metrics: { ...empty(), ...(r.metrics as object) },
      })),
    resources: rows
      .filter((r) => String(r.key).startsWith("resource:"))
      .map((r) => ({
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        streamId: r.stream_id,
        metrics: { ...empty(), ...(r.metrics as object) },
        metricCoverage: coverageFor(r),
        coverage:
          historicalCoverage === "partial"
            ? "partial"
            : Object.values(r.coverage as Record<string, string>).some((c) => c === "partial")
              ? "partial"
              : Object.values(r.coverage as Record<string, string>).some((c) => c === "estimated")
                ? "estimated"
                : "observed",
      })),
    projects: rows
      .filter((r) => String(r.key).startsWith("project:"))
      .map((r) => ({
        projectId: r.project_id,
        metrics: { ...empty(), ...(r.metrics as object) },
        metricCoverage: coverageFor(r),
        coverage:
          historicalCoverage === "partial"
            ? "partial"
            : Object.values(r.coverage as Record<string, string>).some((v) => v === "partial")
              ? "partial"
              : Object.values(r.coverage as Record<string, string>).some((v) => v === "estimated")
                ? "estimated"
                : "observed",
      })),
    coverage,
    journalStartedAt: activation,
    historicalCoverage,
    deliveryAuthority: "origin",
    pricing: "unpriced",
    resourceLimit: 100,
    resourcesTruncated: summary?.truncated ?? false,
  });
}
