import { sql, type SQL } from "drizzle-orm";

export interface UsageReportScope {
  organizationId: string;
  projectId: string | null;
  environmentId: string | null;
}

export type UsageRange = "24h" | "7d" | "14d" | "30d";
export type AnalyticsRange = "live" | "24h" | "7d" | "30d";

const projectFilter = (alias: string, projectId: SQL | null) =>
  projectId === null
    ? sql`true`
    : sql`${sql.identifier(alias)}.${sql.identifier("project_id")} = ${projectId}`;

const usageSummary = (projectId: SQL | null, bucket?: { starts: SQL; ends: SQL }): SQL => {
  const starts = bucket?.starts ?? sql`(select starts from bounds)`;
  const ends = bucket?.ends ?? sql`(select ends from bounds)`;
  const duration = (table: string) => sql`coalesce((select sum(extract(epoch from
    least(i.ends, ${ends}) - greatest(i.starts, ${starts})))
    from ${sql.identifier(table)} i where i.starts < ${ends} and i.ends > ${starts}
      and ${projectFilter("i", projectId)}), 0)`;
  const peak = (table: string): SQL =>
    bucket
      ? sql`coalesce((select max(active) from (
      select sum(sum(delta)) over (order by at) as active from (
        select greatest(i.starts, ${starts}) as at, 1 as delta
        from ${sql.identifier(table === "participant_events" ? "participant_intervals" : "room_intervals")} i
        where i.starts < ${ends} and i.ends > ${starts} and ${projectFilter("i", projectId)}
        union all
        select least(i.ends, ${ends}) as at, -1 as delta
        from ${sql.identifier(table === "participant_events" ? "participant_intervals" : "room_intervals")} i
        where i.starts < ${ends} and i.ends > ${starts} and ${projectFilter("i", projectId)}
      ) events group by at
    ) ranked), 0)`
      : sql`coalesce((select max(active) from (
    select sum(sum(delta)) over (order by at) as active
    from ${sql.identifier(table)} e where ${projectFilter("e", projectId)} group by at
  ) ranked), 0)`;
  const events = [
    "audioParticipantSeconds",
    "videoParticipantSeconds",
    "screenShareSeconds",
    "screenShareIngressBytes",
    "screenShareEgressBytes",
    "sfuIngressBytes",
    "sfuEgressBytes",
    "turnIngressBytes",
    "turnEgressBytes",
    "messagesIn",
    "messagesOut",
  ];
  const pairs = events.map(
    (metric) => sql`${metric}::text,
    coalesce((select sum(value) from ${bucket ? sql`scoped_usage_events` : sql`event_totals`} e where metric = ${metric}
      ${bucket ? sql`and e.occurred_at >= ${starts} and e.occurred_at < ${ends}` : sql``}
      and ${projectFilter("e", projectId)}), 0)`,
  );
  return sql`jsonb_build_object(
    'participantSeconds', ${duration("participant_intervals")},
    'roomsCreated', (select count(*) from scoped_rooms r, bounds b
      where r.created_at >= ${starts} and r.created_at < ${ends} and ${projectFilter("r", projectId)}),
    'roomsStarted', (select count(*) from scoped_rooms r, bounds b
      where r.started_at >= ${starts} and r.started_at < ${ends} and ${projectFilter("r", projectId)}),
    'roomSeconds', ${duration("room_intervals")},
    'averageConcurrentParticipants', ${duration("participant_intervals")}
      / extract(epoch from ${ends} - ${starts}),
    'peakConcurrentParticipants', ${peak("participant_events")},
    'peakConcurrentRooms', ${peak("room_events")},
    'signalingConnections', (select count(*) from scoped_lifecycle_events s
      where s.event_type = 'connection.opened' and s.occurred_at >= ${starts} and s.occurred_at < ${ends}
        and ${projectFilter("s", projectId)}),
    'signalingConnectionSeconds', ${duration("connections")},
    'turnSessions', (select count(*) from scoped_turn_allocations t cross join bounds b
      where t.started_at >= ${starts} and t.started_at < ${ends} and ${projectFilter("t", projectId)}),
    'turnRelaySeconds', coalesce((select sum(extract(epoch from least(t.last_observed_at, t.ended_at, t.expires_at, ${ends}) - greatest(t.started_at, ${starts})))
      from scoped_turn_allocations t cross join bounds b where t.started_at < ${ends}
        and least(t.last_observed_at, t.ended_at, t.expires_at) > greatest(t.started_at, ${starts})
        and ${projectFilter("t", projectId)}), 0),
    ${sql.join(pairs, sql`, `)}
  )`;
};

const historyComplete = (projectId: SQL | null): SQL => sql`not exists (
  select 1 from scoped_sessions s cross join bounds b
  where s.metering_started_at > s.joined_at and s.metering_started_at > b.starts
    and s.joined_at < b.ends
    and coalesce(s.disconnected_at, s.left_at, s.room_ended_at, b.ends) > b.starts
    and ${projectFilter("s", projectId)}
) and not exists (
  select 1 from connections c join scoped_sessions s on s.id = c.session_id
  where c.ends = s.owner_expires_at and ${projectFilter("c", projectId)}
) and not exists (
  select 1 from scoped_lifecycle_events e where e.boundary = 'lease_bound'
    and ${projectFilter("e", projectId)}
) and not exists (
  select 1 from room_intervals r where r.ends = r.owner_expires_at
    and ${projectFilter("r", projectId)}
)`;

export function createUsageReportQuery(
  scope: UsageReportScope,
  range: UsageRange | AnalyticsRange,
  endedAt = new Date(),
  pagination = { limit: 50, offset: 0 },
  projection?: SQL,
  windowStartedAt?: Date,
  bucketGranularity?: "hour" | "day",
) {
  const duration = {
    live: 900_000,
    "24h": 86_400_000,
    "7d": 7 * 86_400_000,
    "14d": 14 * 86_400_000,
    "30d": 30 * 86_400_000,
  }[range];
  const startedAt = windowStartedAt ?? new Date(endedAt.getTime() - duration);
  if (
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(endedAt.getTime()) ||
    startedAt >= endedAt
  )
    throw new Error("A positive usage window is required");
  const granularity =
    bucketGranularity ?? (range === "live" ? "minute" : range === "24h" ? "hour" : "day");
  const query = sql`
    with bounds as (
      select ${startedAt.toISOString()}::timestamptz as starts,
        ${endedAt.toISOString()}::timestamptz as ends
    ), scoped_projects as (
      select pr.id from usage_history_project pr where pr.organization_id = ${scope.organizationId}
        ${scope.projectId === null ? sql`` : sql`and pr.id = ${scope.projectId}`}
    ), scoped_rooms as (
      select r.*, coalesce(live.name, r.id) as name from usage_history_room r
      left join room live on live.id = r.id
      join scoped_projects pr on pr.id = r.project_id
      where true
        ${scope.environmentId === null ? sql`` : sql`and r.environment_id = ${scope.environmentId}`}
    ), scoped_sessions as (
      select s.*, s.participant_id as scoped_participant_id, r.ended_at as room_ended_at, r.project_id
      from usage_history_session s
      join scoped_rooms r on r.id = s.room_id
    ), clipped_connections as (
      select s.id as session_id, s.scoped_participant_id as participant_id, s.project_id,
        greatest(i.started_at, s.joined_at, b.starts) as starts,
        least(
          coalesce(i.ended_at,
            case when s.connection_state = 'connected' then b.ends else s.disconnected_at end,
            i.started_at),
          s.left_at, s.room_ended_at, s.owner_expires_at, b.ends
        ) as ends
      from usage_history_interval i
      join scoped_sessions s on s.id = i.session_id
      cross join bounds b
      where i.started_at < b.ends and coalesce(i.ended_at, b.ends) > b.starts
    ), connections as (
      select * from clipped_connections where ends > starts
    ), preceding_connections as (
      select *, max(ends) over (
        partition by participant_id order by starts, ends, session_id
        rows between unbounded preceding and 1 preceding
      ) as previous_end from connections
    ), connection_groups as (
      select *, sum(case when previous_end is null or starts > previous_end then 1 else 0 end)
        over (partition by participant_id order by starts, ends, session_id rows unbounded preceding) as group_id
      from preceding_connections
    ), participant_intervals as (
      select participant_id, project_id, min(starts) as starts, max(ends) as ends
      from connection_groups group by participant_id, project_id, group_id
    ), participant_events as (
      select project_id, starts as at, 1 as delta from participant_intervals
      union all select project_id, ends as at, -1 as delta from participant_intervals
    ), clipped_rooms as (
      select r.project_id, r.owner_expires_at, greatest(coalesce(r.started_at, r.created_at), b.starts) as starts,
        least(coalesce(r.ended_at,
          case when r.status in ('active', 'ending') then b.ends else r.started_at end,
          r.created_at), r.owner_expires_at, b.ends) as ends
      from scoped_rooms r cross join bounds b
      where r.started_at is not null or r.status in ('active', 'ending')
    ), room_intervals as (
      select * from clipped_rooms where ends > starts
    ), room_events as (
      select project_id, starts as at, 1 as delta from room_intervals
      union all select project_id, ends as at, -1 as delta from room_intervals
    ), scoped_lifecycle_events as (
      select e.* from usage_lifecycle_event e join scoped_rooms r on r.id = e.room_id
      cross join bounds b where e.occurred_at >= b.starts and e.occurred_at < b.ends
    ), scoped_usage_events as (
      select ue.* from usage_event ue
      join scoped_projects pr on pr.id = ue.project_id cross join bounds b
      where ue.organization_id = ${scope.organizationId}
        and (ue.metric not in ('turnIngressBytes', 'turnEgressBytes', 'turn.bytes.ingress', 'turn.bytes.egress') or ue.source = 'coturn')
        ${scope.environmentId === null ? sql`` : sql`and ue.environment_id = ${scope.environmentId}`}
        and ue.occurred_at >= b.starts and ue.occurred_at < b.ends
    ), scoped_turn_allocations as (
      select t.* from turn_allocation t join scoped_projects pr on pr.id = t.project_id
      where t.organization_id = ${scope.organizationId}
        ${scope.environmentId === null ? sql`` : sql`and t.environment_id = ${scope.environmentId}`}
    ), turn_collection_ordered as (
      select id, started_at as starts, collected_through_at as ends,
        max(collected_through_at) over (order by started_at, id rows between unbounded preceding and 1 preceding) as preceding_end
      from turn_log_checkpoint where started_at is not null and collected_through_at is not null
    ), turn_collection_groups as (
      select *, sum(case when preceding_end is null or starts > preceding_end then 1 else 0 end)
        over (order by starts, id rows unbounded preceding) as group_id from turn_collection_ordered
    ), turn_collection_intervals as (
      select min(starts) as starts, max(ends) as ends from turn_collection_groups group by group_id
    ), turn_quality as (
      select case when not exists (select 1 from turn_collection_intervals i cross join bounds b
        where i.starts < b.ends and i.ends > b.starts) then 'unavailable'
        when not exists (select 1 from turn_collection_intervals i cross join bounds b
          where i.starts <= b.starts and i.ends >= b.ends)
          or exists (select 1 from turn_log_checkpoint where reconciliation->>'status' = 'different')
          then 'partial'
        when exists (select 1 from scoped_turn_allocations t cross join bounds b
          where t.started_at < b.ends and greatest(t.last_observed_at, t.expires_at) > b.starts and t.coverage = 'partial')
          or exists (select 1 from turn_observation o cross join bounds b where o.allocation_id is null and o.occurred_at >= b.starts and o.occurred_at < b.ends)
          then 'partial' else 'authoritative' end as coverage
    ), event_totals as (
      select project_id, metric, sum(value) as value from scoped_usage_events group by project_id, metric
    ), report_sessions as (
      select s.* from scoped_sessions s cross join bounds b
      where (s.joined_at >= b.starts and s.joined_at < b.ends)
        or exists (select 1 from connections c where c.session_id = s.id)
    ), scoped_quality as (
      select q.* from rtc_quality_metric q join scoped_rooms r on r.id = q.room_id cross join bounds b
      where q.bucket_started_at >= b.starts and q.bucket_started_at < b.ends and q.updated_at <= b.ends
    ), buckets as (
      select greatest(at at time zone 'UTC', b.starts) as starts,
        least((at + ('1 ' || ${granularity})::interval) at time zone 'UTC', b.ends) as ends
      from bounds b cross join lateral generate_series(
        date_trunc(${granularity}, b.starts at time zone 'UTC'),
        b.ends at time zone 'UTC', ('1 ' || ${granularity})::interval
      ) at
      where at at time zone 'UTC' < b.ends
    ), history as (
      select ${historyComplete(null)} as complete
)
    ${
      projection ??
      sql`select ${usageSummary(null)} as summary,
    ${
      scope.projectId === null
        ? sql`'[]'::jsonb`
        : sql`(select coalesce(jsonb_agg(jsonb_build_object(
      'startedAt', to_char(b.starts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endedAt', to_char(b.ends at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'participantSeconds', coalesce((select sum(extract(epoch from
        least(p.ends, b.ends) - greatest(p.starts, b.starts))) from participant_intervals p
        where p.starts < b.ends and p.ends > b.starts), 0),
      'roomsCreated', (select count(*) from scoped_rooms r where r.created_at >= b.starts and r.created_at < b.ends)
    ) order by b.starts), '[]'::jsonb) from buckets b)`
    } as buckets,
    (select complete from history) as complete,
    (select coverage from turn_quality) as turn_coverage,
    (select count(*) from scoped_projects) as total,
    ${
      scope.projectId === null
        ? sql`(select coalesce(jsonb_agg(jsonb_build_object(
      'projectId', pr.id,
      'summary', ${usageSummary(sql`pr.id`)},
      'dataQuality', jsonb_build_object(
        'sessionHistory', case when ${historyComplete(sql`pr.id`)} then 'complete' else 'partial' end,
        'messageHistory', case when ${historyComplete(sql`pr.id`)} then 'complete' else 'partial' end,
        'turnTraffic', (select coverage from turn_quality)
      )
    ) order by pr.id), '[]'::jsonb) from (
      select id from scoped_projects order by id limit ${pagination.limit} offset ${pagination.offset}
    ) pr)`
        : sql`'[]'::jsonb`
    } as projects`
    }
  `;
  return {
    query,
    window: {
      range,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      timezone: "UTC",
      endExclusive: true,
    },
  };
}

export function createPublicUsageReportQuery(
  scope: UsageReportScope,
  startedAt: Date,
  endedAt: Date,
  granularity: "hour" | "day",
) {
  return createUsageReportQuery(
    scope,
    "30d",
    endedAt,
    undefined,
    sql`select ${usageSummary(null)} as summary,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'startedAt', to_char(ub.starts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endedAt', to_char(ub.ends at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'metrics', ${usageSummary(null, { starts: sql`ub.starts`, ends: sql`ub.ends` })}
      ) order by ub.starts), '[]'::jsonb) from buckets ub) as buckets,
      (select complete from history) as complete,
      (select coverage from turn_quality) as turn_coverage`,
    startedAt,
    granularity,
  ).query;
}

export const usageDataQuality = (
  complete: boolean | undefined,
  turnCoverage: unknown = "unavailable",
) => ({
  sessionHistory: complete ? "complete" : "partial",
  messageHistory: complete ? "complete" : "partial",
  turnTraffic:
    turnCoverage === "authoritative"
      ? "authoritative"
      : turnCoverage === "partial"
        ? "partial"
        : "unavailable",
});

export function createUsageAggregationQuery(
  scope: UsageReportScope,
  startedAt: Date,
  endedAt: Date,
) {
  return createUsageReportQuery(
    scope,
    "24h",
    endedAt,
    undefined,
    sql`select ${usageSummary(null)} as metrics, (select complete from history) as complete, (select coverage from turn_quality) as turn_coverage`,
    startedAt,
  ).query;
}
