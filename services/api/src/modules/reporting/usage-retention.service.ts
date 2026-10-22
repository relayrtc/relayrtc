import type { RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";

export const DEFAULT_USAGE_RETENTION_DAYS = 365;

export function readUsageRetentionDays(source: Readonly<Record<string, string | undefined>>) {
  const value = source.USAGE_RETENTION_DAYS ?? String(DEFAULT_USAGE_RETENTION_DAYS);
  if (!/^\d+$/.test(value) || Number(value) < 30 || Number(value) > 3650)
    throw new Error("USAGE_RETENTION_DAYS must be an integer between 30 and 3650");
  return Number(value);
}

export async function expireUsageHistory(
  database: RelayKitDatabase,
  retentionDays = DEFAULT_USAGE_RETENTION_DAYS,
  now = new Date(),
) {
  readUsageRetentionDays({ USAGE_RETENTION_DAYS: String(retentionDays) });
  if (!Number.isFinite(now.getTime())) throw new Error("A valid retention time is required");
  const cutoff = new Date(now.getTime() - retentionDays * 86400_000).toISOString();
  const sourceCutoff = new Date(cutoff);
  sourceCutoff.setUTCMinutes(0, 0, 0);
  const sourceBoundary = sourceCutoff.toISOString();
  return database.transaction(async (transaction) => {
    const [lock] = await transaction.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended('relayrtc:usage-retention', 0)) as acquired`,
    );
    if (lock?.acquired !== true) return { status: "busy" as const, cutoff };
    await transaction.execute(sql`UPDATE service_usage_activation SET retained_from=greatest(coalesce(retained_from,${sourceBoundary}::timestamptz),${sourceBoundary}::timestamptz) WHERE id='streaming-v1'`);
    await transaction.execute(
      sql`delete from usage_aggregation_dirty where hour_started_at + interval '1 hour' < ${cutoff}::timestamptz`,
    );
    await transaction.execute(sql`delete from service_usage_sample where ended_at<${sourceBoundary}::timestamptz`);
    await transaction.execute(sql`delete from service_usage_object where removed_at<${sourceBoundary}::timestamptz`);
    await transaction.execute(
      sql`delete from usage_event where occurred_at < ${sourceBoundary}::timestamptz`,
    );
    await transaction.execute(
      sql`delete from media_usage_sample where occurred_at < ${sourceBoundary}::timestamptz`,
    );
    await transaction.execute(
      sql`delete from usage_lifecycle_event where occurred_at < ${sourceBoundary}::timestamptz`,
    );
    await transaction.execute(sql`delete from turn_observation where occurred_at < ${sourceBoundary}::timestamptz`);
    await transaction.execute(sql`delete from turn_allocation t where coalesce(t.ended_at, t.expires_at) < ${sourceBoundary}::timestamptz
      and not exists (select 1 from turn_observation o where o.allocation_id = t.id)`);
    await transaction.execute(sql`delete from turn_credential c where c.expires_at < ${sourceBoundary}::timestamptz
      and not exists (select 1 from turn_allocation t where t.username = c.username)`);
    await transaction.execute(
      sql`delete from usage_aggregate where (date_trunc('month', window_started_at at time zone 'UTC') + interval '1 month') at time zone 'UTC' < ${cutoff}::timestamptz`,
    );
    await transaction.execute(
      sql`delete from usage_history_interval where ended_at < ${sourceBoundary}::timestamptz`,
    );
    await transaction.execute(sql`
      with expired as (
        select s.id from usage_history_session s left join usage_history_room r on r.id = s.room_id
        where least(s.left_at, r.ended_at, s.deleted_at,
          case when s.connection_state in ('disconnected', 'failed') then s.disconnected_at end) < ${sourceBoundary}::timestamptz
      ), removed_intervals as (
        delete from usage_history_interval where session_id in (select id from expired) returning id
      )
      delete from usage_history_session where id in (select id from expired)
    `);
    await transaction.execute(sql`delete from usage_history_room r where coalesce(r.ended_at, r.deleted_at) < ${cutoff}::timestamptz
      and not exists (select 1 from usage_history_session s where s.room_id = r.id)
      and not exists (select 1 from usage_event e where e.room_id = r.id)
      and not exists (select 1 from turn_allocation t where t.room_id = r.id)
      and not exists (select 1 from turn_credential c where c.room_id = r.id)`);
    await transaction.execute(sql`delete from usage_history_environment e where e.deleted_at < ${cutoff}::timestamptz
      and not exists (select 1 from usage_history_room r where r.environment_id = e.id)
      and not exists (select 1 from usage_event u where u.environment_id = e.id)
      and not exists (select 1 from usage_aggregate a where a.environment_id = e.id)
      and not exists (select 1 from turn_allocation t where t.environment_id = e.id)
      and not exists (select 1 from turn_credential c where c.environment_id = e.id)`);
    await transaction.execute(sql`delete from usage_history_project p where p.deleted_at < ${cutoff}::timestamptz
      and not exists (select 1 from usage_history_environment e where e.project_id = p.id)
      and not exists (select 1 from usage_history_room r where r.project_id = p.id)
      and not exists (select 1 from usage_event u where u.project_id = p.id)
      and not exists (select 1 from usage_aggregate a where a.project_id = p.id)`);
    await transaction.execute(sql`delete from usage_history_organization o where o.deleted_at < ${cutoff}::timestamptz
      and not exists (select 1 from usage_history_project p where p.organization_id = o.id)
      and not exists (select 1 from usage_event e where e.organization_id = o.id)
      and not exists (select 1 from usage_aggregate a where a.organization_id = o.id)`);
    await transaction.execute(
      sql`delete from usage_aggregation_dirty d where not exists (select 1 from usage_history_organization o where o.id = d.organization_id)`,
    );
    await transaction.execute(sql`delete from usage_aggregation_checkpoint c where not exists (select 1 from usage_history_organization o where o.id = c.organization_id)
      and not exists (select 1 from usage_aggregation_dirty d where d.organization_id = c.organization_id)`);
    return { status: "expired" as const, cutoff };
  });
}
