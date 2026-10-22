import { getServiceUsage } from "../reporting/service-usage-report.js";
import type { RelayKitDatabase } from "@relayrtc/database";
import { usageMetricDefinitions, type UsageMetrics } from "@relayrtc/types";
import {
  publicUsageResponseSchema,
  reportingUsageMetricsSchema,
  type PublicUsageCategory,
  type PublicUsageQuery,
} from "@relayrtc/validation";

import { ApiError } from "../../http/errors/api-error.js";
import { createPublicUsageReportQuery, usageDataQuality } from "../reporting/usage-query.js";
import { DEFAULT_USAGE_RETENTION_DAYS } from "../reporting/usage-retention.service.js";

const categoryMetrics = {
  rooms: ["roomsCreated", "roomsStarted", "roomSeconds", "peakConcurrentRooms"],
  participants: [
    "participantSeconds",
    "participantMinutesDerived",
    "audioParticipantSeconds",
    "videoParticipantSeconds",
    "peakConcurrentParticipants",
    "averageConcurrentParticipants",
  ],
  sfu: ["sfuIngressBytes", "sfuEgressBytes"],
  turn: ["turnIngressBytes", "turnEgressBytes", "turnRelaySeconds", "turnSessions"],
  signaling: [
    "signalingConnections",
    "signalingConnectionSeconds",
    "signalingMessagesIn",
    "signalingMessagesOut",
  ],
  "screen-share": ["screenShareSeconds", "screenShareIngressBytes", "screenShareEgressBytes"],
} as const satisfies Record<Exclude<PublicUsageCategory, "all" | "streaming">, readonly (keyof UsageMetrics)[]>;

export async function getPublicUsage(
  database: RelayKitDatabase,
  scope: { organizationId: string; projectId: string; environmentId: string },
  query: PublicUsageQuery,
  category: PublicUsageCategory,
  now = new Date(),
  retentionDays = DEFAULT_USAGE_RETENTION_DAYS,
) {
  const range = query.startedAt === undefined ? (query.range ?? "7d") : "custom";
  const durations = {
    "24h": 86400_000,
    "7d": 7 * 86400_000,
    "14d": 14 * 86400_000,
    "30d": 30 * 86400_000,
  };
  const endedAt = query.endedAt === undefined ? now : new Date(query.endedAt);
  const startedAt =
    query.startedAt === undefined
      ? new Date(endedAt.getTime() - durations[range === "custom" ? "7d" : range])
      : new Date(query.startedAt);
  if (
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(endedAt.getTime()) ||
    endedAt > now ||
    startedAt.getTime() < now.getTime() - retentionDays * 86400_000 ||
    startedAt >= endedAt ||
    endedAt.getTime() - startedAt.getTime() > durations["30d"]
  ) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Usage windows must be within retained history, in the past, positive, and at most 30 days",
    );
  }
  const granularity =
    query.granularity ??
    (endedAt.getTime() - startedAt.getTime() <= durations["24h"] ? "hour" : "day");
  const metrics =
    category === "all" ? Object.values(categoryMetrics).flat() : category === "streaming" ? [] : [...categoryMetrics[category]];
  const selectMetrics = (value: unknown) => {
    const { messagesIn, messagesOut, ...report } = reportingUsageMetricsSchema.parse(value);
    const canonical = {
      ...report,
      participantMinutesDerived: report.participantSeconds / 60,
      signalingMessagesIn: messagesIn,
      signalingMessagesOut: messagesOut,
    };
    return Object.fromEntries(metrics.map((metric) => [metric, canonical[metric]]));
  };
  const row = await database.transaction(async (transaction) => {
    await transaction.execute("set local statement_timeout = '15s'");
    const [result] = await transaction.execute(
      createPublicUsageReportQuery(scope, startedAt, endedAt, granularity),
    );
    return result as {
      summary: unknown;
      buckets: { startedAt: string; endedAt: string; metrics: unknown }[];
      complete: boolean;
      turn_coverage: unknown;
    };
  });
  return publicUsageResponseSchema.parse({
    scope,
    category,
    window: {
      range,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      timezone: "UTC",
      endExclusive: true,
    },
    bucketDefinition: {
      granularity,
      alignment: "UTC calendar boundaries",
      partialEdges: "clipped to requested window",
      durations: "lifecycle intervals clipped to each bucket",
      events: "attributed to occurrence time",
    },
    metricDefinitions: Object.fromEntries(
      metrics.map((metric) => [metric, usageMetricDefinitions[metric]]),
    ),
    serviceUsage: category === "all" || category === "streaming" ? await getServiceUsage(database, scope, { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), granularity }, now) : undefined,
    summary: selectMetrics(row.summary),
    buckets: row.buckets.map((bucket) => ({ ...bucket, metrics: selectMetrics(bucket.metrics) })),
    dataQuality: {
      ...usageDataQuality(row.complete, row.turn_coverage),
      mediaDurations: "observation_time",
    },
  });
}
