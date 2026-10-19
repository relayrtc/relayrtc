import type { ConnectionQuality } from "@relayrtc/types";

import type { SubscriberNetworkStats } from "../engine/quality-controller.js";

export const qualitySeverity: Record<ConnectionQuality, number> = {
  excellent: 0,
  good: 1,
  poor: 2,
  critical: 3,
  lost: 4,
};

export const classifyConnectionQuality = (stats: SubscriberNetworkStats): ConnectionQuality => {
  const totalPackets = stats.packetsLost + stats.packetsReceived;
  const packetLoss =
    stats.packetLossRatio ?? (totalPackets === 0 ? 0 : stats.packetsLost / totalPackets);
  const bitrate = stats.availableIncomingBitrate;
  const roundTripTime = stats.roundTripTime ?? 0;
  const jitter = stats.jitter ?? 0;

  if (stats.stale || (bitrate === 0 && stats.packetsReceived === 0)) return "lost";
  if (
    packetLoss >= 0.2 ||
    roundTripTime >= 1 ||
    jitter >= 0.2 ||
    (bitrate !== null && bitrate < 80_000)
  ) {
    return "critical";
  }
  if (
    packetLoss >= 0.08 ||
    roundTripTime >= 0.5 ||
    jitter >= 0.08 ||
    (bitrate !== null && bitrate < 500_000)
  ) {
    return "poor";
  }
  if (
    packetLoss >= 0.03 ||
    roundTripTime >= 0.25 ||
    jitter >= 0.03 ||
    (bitrate !== null && bitrate < 2_500_000)
  ) {
    return "good";
  }
  return "excellent";
};

export const qualityTransitionEvent = (
  previous: ConnectionQuality | undefined,
  quality: ConnectionQuality,
): "connection.degraded" | "connection.recovered" | null => {
  if (!previous) return null;
  const wasDegraded = qualitySeverity[previous] >= qualitySeverity.poor;
  const isDegraded = qualitySeverity[quality] >= qualitySeverity.poor;
  if (!wasDegraded && isDegraded) return "connection.degraded";
  if (wasDegraded && !isDegraded) return "connection.recovered";
  return null;
};

export const intervalNetworkStats = (
  current: SubscriberNetworkStats,
  previous: SubscriberNetworkStats | undefined,
): SubscriberNetworkStats => {
  if (
    !previous ||
    previous.stale ||
    current.timestamp <= previous.timestamp ||
    current.timestamp - previous.timestamp > 10_000 ||
    current.packetsLost < previous.packetsLost ||
    current.packetsReceived < previous.packetsReceived
  )
    return { ...current, packetsLost: 0, packetsReceived: 0 };
  return {
    ...current,
    packetsLost: Math.max(0, current.packetsLost - previous.packetsLost),
    packetsReceived: Math.max(0, current.packetsReceived - previous.packetsReceived),
  };
};
