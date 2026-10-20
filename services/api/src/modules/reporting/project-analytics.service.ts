import { getServiceUsage } from "./service-usage-report.js";
import type { RelayKitDatabase } from "@relayrtc/database";
import {
  projectAnalyticsResponseSchema,
  type ProjectAnalyticsResponse,
} from "@relayrtc/validation";
import { sql } from "drizzle-orm";

import type { ProjectUsageScope } from "./project-usage.service.js";
import { createUsageReportQuery, usageDataQuality, type AnalyticsRange } from "./usage-query.js";

export async function getProjectAnalytics(
  database: RelayKitDatabase,
  scope: ProjectUsageScope,
  range: AnalyticsRange,
  endedAt = new Date(),
): Promise<ProjectAnalyticsResponse> {
  const timestamps = sql`'startedAt', to_char(b.starts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endedAt', to_char(b.ends at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const networkMetrics = [
    "sfuIngressBytes",
    "sfuEgressBytes",
    "turnIngressBytes",
    "turnEgressBytes",
  ];
  const network = (bucket: boolean) =>
    sql`jsonb_build_object(${sql.join(
      networkMetrics.map(
        (metric) => sql`
    ${metric}::text, coalesce((select sum(e.value) from scoped_usage_events e where e.metric = ${metric}
      ${bucket ? sql`and e.occurred_at >= b.starts and e.occurred_at < b.ends` : sql``}), 0)`,
      ),
      sql`, `,
    )})`;
  const projection = sql`select jsonb_build_object(
    'peakConcurrent', coalesce((select max(active) from (
      select sum(sum(delta)) over (order by at) active from participant_events group by at
    ) ranked), 0),
    'totalSessions', (select count(*) from report_sessions),
    'averageSessionSeconds', coalesce((select avg(seconds) from (
      select s.id, coalesce(sum(extract(epoch from c.ends - c.starts)), 0) seconds
      from report_sessions s left join connections c on c.session_id = s.id group by s.id
    ) durations), 0),
    'participantSeconds', coalesce((select sum(extract(epoch from ends - starts)) from participant_intervals), 0),
    'connectionSuccessRate', coalesce((select 100.0 * count(*) filter (where successful) / nullif(count(*), 0) from (
      select s.connection_state, exists (select 1 from connections c where c.session_id = s.id) successful
      from report_sessions s
    ) outcomes where successful or connection_state = 'failed'), 0)
  ) summary,
  ${network(false)} network,
  (select coalesce(jsonb_agg(jsonb_build_object(${timestamps},
    'participants', coalesce((select max(active) from (
      select sum(sum(delta)) over (order by at) active from (
        select greatest(p.starts, b.starts) at, 1 delta from participant_intervals p where p.starts < b.ends and p.ends > b.starts
        union all select least(p.ends, b.ends) at, -1 delta from participant_intervals p where p.starts < b.ends and p.ends > b.starts
      ) events group by at
    ) ranked), 0),
    'sessions', (select count(*) from report_sessions s where
      (s.joined_at >= b.starts and s.joined_at < b.ends) or exists (
        select 1 from connections c where c.session_id = s.id and c.starts < b.ends and c.ends > b.starts)),
    'participantSeconds', coalesce((select sum(extract(epoch from least(p.ends, b.ends) - greatest(p.starts, b.starts)))
      from participant_intervals p where p.starts < b.ends and p.ends > b.starts), 0)
  ) order by b.starts), '[]'::jsonb) from buckets b) traffic,
  (select coalesce(jsonb_agg(jsonb_build_object(${timestamps}) || ${network(true)} order by b.starts), '[]'::jsonb) from buckets b) "networkSeries",
  (select coalesce(jsonb_agg(jsonb_build_object(${timestamps},
    'roundTripTimeMs', (select 1000.0 * sum(q.round_trip_time_sum) / nullif(sum(q.round_trip_time_sample_count), 0)
      from scoped_quality q where q.bucket_started_at >= b.starts and q.bucket_started_at < b.ends),
    'jitterMs', (select 1000.0 * sum(q.jitter_sum) / nullif(sum(q.jitter_sample_count), 0)
      from scoped_quality q where q.bucket_started_at >= b.starts and q.bucket_started_at < b.ends),
    'packetLossPercent', (select 100.0 * sum(greatest(q.packets_lost, 0)) /
      nullif(sum(greatest(q.packets_lost, 0) + greatest(q.packets_received, 0)), 0)
      from scoped_quality q where q.bucket_started_at >= b.starts and q.bucket_started_at < b.ends),
    'sampleCount', (select coalesce(sum(q.sample_count), 0) from scoped_quality q
      where q.bucket_started_at >= b.starts and q.bucket_started_at < b.ends)
  ) order by b.starts), '[]'::jsonb) from buckets b) quality,
  (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'sessions', sessions) order by sessions desc, name), '[]'::jsonb)
    from (select coalesce(nullif(country, ''), 'Unknown') name, count(*) sessions from report_sessions group by 1) grouped) regions,
  (select coalesce(jsonb_agg(jsonb_build_object('quality', quality, 'count', count) order by quality), '[]'::jsonb)
    from (select latest_quality quality, count(*) count from (
      select distinct on (q.participant_id) q.participant_id, q.latest_quality
      from scoped_quality q order by q.participant_id, q.bucket_started_at desc, q.updated_at desc
    ) latest group by latest_quality) grouped) "qualityDistribution",
  (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'participants', participants,
    'participantSeconds', seconds) order by seconds desc, id), '[]'::jsonb) from (
      select r.id, r.name, count(distinct p.participant_id) participants,
        sum(extract(epoch from p.ends - p.starts)) seconds
      from participant_intervals p join (select distinct participant_id, room_id from scoped_sessions) participant on participant.participant_id = p.participant_id
      join scoped_rooms r on r.id = participant.room_id
      group by r.id, r.name order by seconds desc, r.id limit 10
    ) busiest) "topRooms",
  (select complete from history) complete, (select coverage from turn_quality) turn_coverage`;
  const { query, window } = createUsageReportQuery(scope, range, endedAt, undefined, projection);
  const result = await database.execute(query);
  const row = result[0];
  const { complete, turn_coverage: turnCoverage, ...data } = row ?? {};
  return projectAnalyticsResponseSchema.parse({
    ...data,
    scope,
    serviceUsage: await getServiceUsage(database, scope, { startedAt: window.startedAt, endedAt: window.endedAt }, endedAt),
    window,
    qualityGranularitySeconds: 60,
    dataQuality: usageDataQuality(complete === true, turnCoverage),
  });
}
