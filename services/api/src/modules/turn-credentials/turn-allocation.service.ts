import { createHash } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";
import { parseTurnAllocationLog, type TurnAllocationObservation } from "./turn-allocation-log.js";

type Transaction = Parameters<Parameters<RelayKitDatabase["transaction"]>[0]>[0];
const identity = (...parts: (string | number)[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const sourcePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/u;

async function ingest(
  transaction: Transaction,
  source: string,
  offset: number,
  observation: TurnAllocationObservation,
) {
  const at = observation.occurredAt.toISOString();
  const newAllocationId = identity(source, observation.nativeId, offset);
  if (observation.kind === "new") {
    await transaction.execute(sql`
      update turn_allocation set ended_at = greatest(started_at, least(last_observed_at, ${at}::timestamptz)), coverage = 'partial'
      where source_id = ${source} and native_id = ${observation.nativeId}
        and generation_offset < ${offset} and ended_at is null
    `);
    await transaction.execute(sql`
      insert into turn_allocation (id, source_id, native_id, generation_offset, username, organization_id, project_id, environment_id, room_id, session_id, started_at, last_observed_at, expires_at)
      select ${newAllocationId}, ${source}, ${observation.nativeId}, ${offset}, username, organization_id, project_id, environment_id, room_id, session_id,
        ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz + ${observation.lifetime} * interval '1 second'
      from turn_credential where username = ${observation.username}
        and issued_at <= ${at}::timestamptz + interval '5 seconds' and expires_at >= ${at}::timestamptz
        and (revoked_at is null or revoked_at >= ${at}::timestamptz)
        and (realm is null or realm = ${observation.realm})
      on conflict (source_id, native_id, generation_offset) do nothing
    `);
  }
  const [allocation] = await transaction.execute(sql`
    select t.* from turn_allocation t join turn_credential c on c.username = t.username
    where t.source_id = ${source} and t.native_id = ${observation.nativeId}
      and t.username = ${observation.username} and (c.realm is null or c.realm = ${observation.realm})
      and (${observation.kind} <> 'new' or t.id = ${newAllocationId})
      and t.started_at <= ${at}::timestamptz
    order by t.generation_offset desc limit 1 for update of t
  `);
  const allocationId = allocation ? String(allocation.id) : null;
  const attributable =
    allocation !== undefined &&
    (allocation.ended_at === null ||
      observation.occurredAt <= new Date(String(allocation.ended_at)));
  const eventId = identity(source, offset);
  const [inserted] = await transaction.execute(sql`
    insert into turn_observation (id, source_id, native_id, allocation_id, occurred_at, kind, ingress_bytes, egress_bytes)
    values (${eventId}, ${source}, ${observation.nativeId}, ${attributable ? allocationId : null}, ${at}::timestamptz, ${observation.kind}, ${observation.ingressBytes}, ${observation.egressBytes})
    on conflict do nothing returning id
  `);
  if (!inserted) return;
  if (!attributable) {
    await transaction.execute(
      sql`update turn_log_checkpoint set rejected_observations = rejected_observations + 1 where id = ${source}`,
    );
    return;
  }
  if (observation.kind === "client" || observation.kind === "peer") {
    const ingress = observation.kind === "client" ? "client_ingress_bytes" : "peer_ingress_bytes";
    const egress = observation.kind === "client" ? "client_egress_bytes" : "peer_egress_bytes";
    await transaction.execute(sql`
      update turn_allocation set ${sql.identifier(ingress)} = ${sql.identifier(ingress)} + ${observation.ingressBytes},
        ${sql.identifier(egress)} = ${sql.identifier(egress)} + ${observation.egressBytes},
        last_observed_at = greatest(last_observed_at, ${at}::timestamptz) where id = ${allocationId}
    `);
    for (const [metric, value] of [
      ["turnIngressBytes", observation.ingressBytes],
      ["turnEgressBytes", observation.egressBytes],
    ] as const) {
      if (value === 0) continue;
      await transaction.execute(sql`
        insert into usage_event (id, organization_id, project_id, environment_id, room_id, metric, value, occurred_at, source)
        values (${`turn_${eventId}_${metric}`}, ${String(allocation.organization_id)}, ${String(allocation.project_id)},
          ${String(allocation.environment_id)}, ${allocation.room_id as string | null}, ${metric}, ${value}, ${at}::timestamptz, 'coturn')
      `);
    }
  } else if (observation.kind === "refreshed") {
    await transaction.execute(sql`
      update turn_allocation set last_observed_at = greatest(last_observed_at, ${at}::timestamptz),
        expires_at = case when ${at}::timestamptz >= last_observed_at then ${at}::timestamptz + ${observation.lifetime} * interval '1 second' else expires_at end
      where id = ${allocationId} and ended_at is null
    `);
  } else if (observation.kind === "deleted") {
    await transaction.execute(sql`
      update turn_allocation set ended_at = least(ended_at, ${at}::timestamptz), last_observed_at = greatest(last_observed_at, ${at}::timestamptz),
        coverage = case when exists (select 1 from turn_observation where allocation_id = ${allocationId} and kind = 'client' and occurred_at between ${at}::timestamptz - interval '1 second' and ${at}::timestamptz)
          and exists (select 1 from turn_observation where allocation_id = ${allocationId} and kind = 'peer' and occurred_at between ${at}::timestamptz - interval '1 second' and ${at}::timestamptz)
          then 'complete' else 'partial' end
      where id = ${allocationId}
    `);
  }
}

export async function collectTurnAllocationLogs(database: RelayKitDatabase, directory: string) {
  const observedThrough = new Date().toISOString();
  const current = (await readFile(join(directory, "current"), "utf8")).trim();
  if (!sourcePattern.test(current)) throw new Error("Invalid current coturn source identity");
  const files = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && sourcePattern.test(entry.name),
  );
  if (!files.some((file) => file.name === current))
    throw new Error("The current coturn accounting log is missing; configure durable file logging");
  let processedBytes = 0;
  let caughtUp = files.some((file) => file.name === current);
  for (const file of files) {
    const result = await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local statement_timeout = '15s'`);
      await transaction.execute(sql`set local lock_timeout = '2s'`);
      const [lock] = await transaction.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`turn:${file.name}`}, 0)) as acquired`,
      );
      if (lock?.acquired !== true) return { bytes: 0, caughtUp: false };
      await transaction.execute(
        sql`insert into turn_log_checkpoint (id) values (${file.name}) on conflict do nothing`,
      );
      const [checkpoint] = await transaction.execute(
        sql`select byte_offset from turn_log_checkpoint where id = ${file.name} for update`,
      );
      const offset = Number(checkpoint?.byte_offset);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error("Invalid coturn log checkpoint");
      const handle = await open(join(directory, file.name), "r");
      try {
        const size = (await handle.stat()).size;
        if (size < offset) throw new Error("A durable coturn log was truncated");
        const buffer = Buffer.alloc(Math.min(262144, size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        let end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
        if (end === 0) {
          if (bytesRead === 262144) throw new Error("Coturn log line exceeds the collection limit");
          await transaction.execute(
            sql`update turn_log_checkpoint set updated_at = now() where id = ${file.name}`,
          );
          return { bytes: 0, caughtUp: size === offset };
        }
        let start = 0;
        let observations = 0;
        let firstTimestamp: string | undefined;
        let lastObservation: Date | undefined;
        while (start < end) {
          const next = buffer.indexOf(10, start);
          const line = buffer.subarray(start, next).toString("utf8");
          const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u.exec(line)?.[0];
          if (timestamp && (!firstTimestamp || timestamp < firstTimestamp))
            firstTimestamp = timestamp;
          const observation = parseTurnAllocationLog(line);
          if (observation) {
            if (observation.occurredAt.getTime() > Date.now() + 300000)
              throw new Error("Coturn clock is ahead of the collector");
            await ingest(transaction, file.name, offset + start, observation);
            if (!lastObservation || observation.occurredAt > lastObservation)
              lastObservation = observation.occurredAt;
            observations++;
          }
          start = next + 1;
          if (observations >= 128) {
            end = start;
            break;
          }
        }
        await transaction.execute(
          sql`update turn_log_checkpoint set byte_offset = ${offset + end}, updated_at = now(),
            started_at = least(started_at, ${firstTimestamp ?? null}::timestamptz),
            last_observed_at = greatest(last_observed_at, ${lastObservation?.toISOString() ?? null}::timestamptz)
            where id = ${file.name}`,
        );
        return { bytes: end, caughtUp: offset + end === (await handle.stat()).size };
      } finally {
        await handle.close();
      }
    });
    processedBytes += result.bytes;
    caughtUp &&= result.caughtUp;
  }
  caughtUp &&= (await readFile(join(directory, "current"), "utf8")).trim() === current;
  if (caughtUp)
    await database.execute(
      sql`update turn_log_checkpoint set collected_through_at = greatest(collected_through_at, ${observedThrough}::timestamptz) where id = ${current}`,
    );
  return { files: files.length, processedBytes, caughtUp };
}

export async function reconcileTurnAllocations(
  database: RelayKitDatabase,
  directory: string,
  metricsUrl: string,
) {
  const source = (await readFile(join(directory, "current"), "utf8")).trim();
  if (!sourcePattern.test(source)) throw new Error("Invalid current coturn source identity");
  const response = await fetch(metricsUrl, {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Coturn metrics are unavailable");
  const text = await response.text();
  if (text.length > 1048576) throw new Error("Coturn metrics exceed the collection limit");
  const metrics: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match =
      /^(turn_total_allocations|turn_total_traffic_(?:peer_)?(?:rcvp|rcvb|sentp|sentb))(?:_total)?(?:\{[^}]*\})? ([0-9.e+]+)$/u.exec(
        line,
      );
    if (match?.[1] && match[2]) metrics[match[1]] = (metrics[match[1]] ?? 0) + Number(match[2]);
  }
  const [totals] = await database.execute(sql`
    with finished as (select distinct allocation_id from turn_observation where source_id = ${source} and kind = 'deleted' and allocation_id is not null)
    select (select count(*) from turn_allocation where source_id = ${source} and ended_at is null and expires_at > now()) as active,
      (select count(*) from turn_allocation where source_id = ${source}) as sessions,
      coalesce(sum(ingress_bytes), 0) as ingress_bytes, coalesce(sum(egress_bytes), 0) as egress_bytes,
      coalesce(sum(ingress_bytes) filter (where allocation_id is null), 0) as unattributed_ingress_bytes,
      coalesce(sum(egress_bytes) filter (where allocation_id is null), 0) as unattributed_egress_bytes,
      coalesce(sum(ingress_bytes) filter (where allocation_id in (select allocation_id from finished)), 0) as finished_ingress_bytes,
      coalesce(sum(egress_bytes) filter (where allocation_id in (select allocation_id from finished)), 0) as finished_egress_bytes
    from turn_observation where source_id = ${source}
  `);
  const finishedIngress =
    metrics.turn_total_traffic_rcvb !== undefined &&
    metrics.turn_total_traffic_peer_rcvb !== undefined
      ? metrics.turn_total_traffic_rcvb + metrics.turn_total_traffic_peer_rcvb
      : undefined;
  const finishedEgress =
    metrics.turn_total_traffic_sentb !== undefined &&
    metrics.turn_total_traffic_peer_sentb !== undefined
      ? metrics.turn_total_traffic_sentb + metrics.turn_total_traffic_peer_sentb
      : undefined;
  const snapshot = {
    sourceId: source,
    observedAt: new Date().toISOString(),
    ledger: totals,
    coturn: metrics,
    activeAllocationDifference:
      metrics.turn_total_allocations === undefined
        ? null
        : metrics.turn_total_allocations - Number(totals?.active),
    finishedIngressDifference:
      finishedIngress === undefined
        ? null
        : finishedIngress - Number(totals?.finished_ingress_bytes),
    finishedEgressDifference:
      finishedEgress === undefined ? null : finishedEgress - Number(totals?.finished_egress_bytes),
    coverage: "partial",
  };
  const differences = [
    snapshot.activeAllocationDifference,
    snapshot.finishedIngressDifference,
    snapshot.finishedEgressDifference,
  ];
  const reconciliation = {
    ...snapshot,
    status: differences.some((value) => value === null)
      ? "unavailable"
      : differences.every((value) => value === 0)
        ? "matched"
        : "different",
  };
  await database.execute(
    sql`update turn_log_checkpoint set reconciliation = ${JSON.stringify(reconciliation)}::jsonb where id = ${source}`,
  );
  return reconciliation;
}
