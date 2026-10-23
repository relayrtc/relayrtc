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
    observations AS (SELECT s.project_id,s.resource_type,s.resource_id,s.stream_id,s.metrics,s.started_at,s.ended_at,s.occurred_at,s.coverage FROM service_usage_sample s,bounds WHERE ${filter} AND s.started_at<hi AND s.ended_at>=lo),
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
    -- Expand JSON once; aggregate all scopes together instead of comparing each
    -- metric with every resource window. Buckets split intervals proportionally
    -- and attribute events once, including events on an exact bucket boundary.
    observation_metrics AS MATERIALIZED (
      SELECT s.project_id,s.resource_type,s.resource_id,s.started_at,s.ended_at,s.occurred_at,s.coverage,
        e.key metric,e.value::float8 metric_value,d.attribution
      FROM observations s CROSS JOIN LATERAL jsonb_each_text(s.metrics) e JOIN definitions d ON d.metric=e.key
    ),
    metric_buckets AS (
      SELECT s.*,b bucket,
        CASE WHEN s.attribution='interval' THEN
          coalesce(s.metric_value * extract(epoch FROM least(s.ended_at,hi,b+${`1 ${window.granularity}`}::interval)-greatest(s.started_at,lo,b))/nullif(extract(epoch FROM s.ended_at-s.started_at),0),0)
        ELSE s.metric_value END value
      FROM observation_metrics s CROSS JOIN bounds
      CROSS JOIN LATERAL generate_series(
        date_trunc(${window.granularity},(CASE WHEN s.attribution='interval' THEN greatest(s.started_at,lo) ELSE s.occurred_at END) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        CASE WHEN s.attribution='interval' THEN least(s.ended_at,hi) ELSE s.occurred_at END,${`1 ${window.granularity}`}::interval) b
      WHERE b<hi AND ((s.attribution='interval' AND s.started_at<least(hi,b+${`1 ${window.granularity}`}::interval) AND s.ended_at>greatest(lo,b))
        OR (s.attribution='event' AND s.occurred_at>=lo AND s.occurred_at<hi))
    ),
    values_by_window AS (
      SELECT CASE ${scope.projectId ? sql`` : sql`WHEN grouping(s.project_id)=0 THEN 'project:'||s.project_id`}
        WHEN grouping(s.resource_id)=0 THEN 'resource:'||s.resource_type||':'||s.resource_id
        WHEN grouping(s.bucket)=0 THEN 'bucket:'||s.bucket::text ELSE 'summary' END key,s.metric,
        sum(s.value)::float8 value,
        CASE WHEN bool_or(s.coverage IN ('partial','unavailable')) THEN 'partial' WHEN s.metric='viewerSeconds' OR bool_or(s.coverage='estimated') THEN 'estimated' ELSE 'observed' END coverage
      FROM metric_buckets s
      GROUP BY GROUPING SETS ((s.metric),${scope.projectId ? sql`` : sql`(s.metric,s.project_id),`}(s.metric,s.resource_type,s.resource_id),(s.metric,s.bucket))
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
      SELECT w.key,e.at,e.delta FROM observations s CROSS JOIN bounds
      CROSS JOIN LATERAL (
        SELECT 'summary' key,lo starts,hi ends
        ${scope.projectId ? sql`` : sql`UNION ALL SELECT 'project:'||s.project_id,lo,hi`}
        UNION ALL SELECT 'resource:'||s.resource_type||':'||s.resource_id,lo,hi
        UNION ALL SELECT 'bucket:'||b::text,greatest(lo,b),least(hi,b+${`1 ${window.granularity}`}::interval)
          FROM generate_series(date_trunc(${window.granularity},greatest(s.started_at,lo) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',least(s.ended_at,hi),${`1 ${window.granularity}`}::interval) b WHERE b<hi
      ) w
      CROSS JOIN LATERAL (VALUES (greatest(s.started_at,w.starts),1),(least(s.ended_at,w.ends),-1)) e(at,delta)
      WHERE (s.metrics->>'viewerSeconds')::float8>0 AND s.started_at<w.ends AND s.ended_at>w.starts
    ),
    viewer_peaks AS (SELECT key,max(active)::float8 value FROM (SELECT key,sum(sum(delta)) OVER (PARTITION BY key ORDER BY at) active FROM viewer_edges GROUP BY key,at) a GROUP BY key),
    scoped_values AS (SELECT * FROM values_by_window UNION ALL SELECT key,'peakConcurrentViewers',value,'estimated' FROM viewer_peaks),
    values_complete AS (SELECT * FROM scoped_values ${scope.projectId ? sql`UNION ALL SELECT ${`project:${scope.projectId}`},metric,value,coverage FROM scoped_values WHERE key='summary'` : sql``}),
    report_values AS (SELECT key,jsonb_object_agg(metric,value) metrics,jsonb_object_agg(metric,coverage) coverage FROM values_complete GROUP BY key)
    SELECT w.*,
      coalesce(v.metrics,'{}'::jsonb) metrics,
      coalesce(v.coverage,'{}'::jsonb) coverage,
      (SELECT started_at FROM service_usage_activation WHERE id='streaming-v1') journal_started_at,
      (SELECT retained_from FROM service_usage_activation WHERE id='streaming-v1') retained_from,
      (SELECT count(*)>100 FROM inventory) truncated
    FROM windows w LEFT JOIN report_values v ON v.key=w.key ORDER BY w.starts,w.key
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
      throw new ApiError(
        400,
        "USAGE_HISTORY_EXPIRED",
        "Select a window within retained service history.",
      );
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
