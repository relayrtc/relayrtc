import type { ProjectAnalyticsResponse } from "@relayrtc/validation";
export type { AnalyticsRange } from "./client";

export function analyticsView(data: ProjectAnalyticsResponse) {
  const label = (startedAt: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      ...(data.window.range === "live" || data.window.range === "24h"
        ? ({ hour: "2-digit", minute: "2-digit", hour12: false } as const)
        : ({ month: "short", day: "numeric" } as const)),
    }).format(new Date(startedAt));
  const network = (point: ProjectAnalyticsResponse["network"]) => ({
    sfuIngress: point.sfuIngressBytes,
    sfuEgress: point.sfuEgressBytes,
    turnIngress: point.turnIngressBytes,
    turnEgress: point.turnEgressBytes,
  });
  return {
    window: data.window,
    summary: data.summary,
    dataQuality: data.dataQuality,
    network: network(data.network),
    traffic: data.traffic.map((point) => ({ ...point, label: label(point.startedAt) })),
    networkSeries: data.networkSeries.map((point) => ({
      ...network(point),
      label: label(point.startedAt),
    })),
    quality: data.quality.map((point) => ({
      label: label(point.startedAt),
      rtt: point.roundTripTimeMs,
      jitter: point.jitterMs,
      packetLoss: point.packetLossPercent,
      sampleCount: point.sampleCount,
    })),
    regions: data.regions,
    qualityDistribution: data.qualityDistribution,
    topRooms: data.topRooms.map((room) => ({ ...room, minutes: room.participantSeconds / 60 })),
  };
}
export type ProjectAnalyticsData = ReturnType<typeof analyticsView>;
