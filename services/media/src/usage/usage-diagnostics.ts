import type { RtpByteCounters } from "./rtp-byte-counters.js";

export interface UsageCheckpoint {
  readonly id: string;
  readonly sampledAt: number;
  readonly previous: RtpByteCounters;
  readonly counters: RtpByteCounters;
  readonly metrics: Readonly<Partial<Record<string, number>>>;
}

export function describeUsageCheckpoint(checkpoint: UsageCheckpoint | undefined) {
  if (!checkpoint) return null;
  return {
    sampleId: checkpoint.id,
    zeroDelta: Object.values(checkpoint.metrics).every((value) => value === 0),
    observedAt: new Date(checkpoint.sampledAt).toISOString(),
    metrics: checkpoint.metrics,
    streamCount: checkpoint.counters.size,
    truncated: checkpoint.counters.size > 16,
    streams: [...checkpoint.counters].slice(0, 16).map(([ssrc, counter]) => {
      const previous = checkpoint.previous.get(ssrc);
      const absent = previous?.timestamp === counter.timestamp && previous.bytes === counter.bytes;
      return {
        ssrc,
        timestamp: counter.timestamp,
        byteCount: counter.bytes,
        previousByteCount: previous?.bytes ?? null,
        previousTimestamp: previous?.timestamp ?? null,
        delta: absent
          ? 0
          : !previous || counter.bytes < previous.bytes
            ? counter.bytes
            : counter.bytes - previous.bytes,
        reason: absent
          ? "retained"
          : !previous
            ? "first-observation"
            : counter.bytes < previous.bytes
              ? "counter-reset"
              : "increment",
      };
    }),
  };
}

interface RtpDiagnosticStat {
  readonly type: string;
  readonly timestamp: number;
  readonly ssrc: number;
  readonly byteCount: number;
  readonly packetCount: number;
  readonly bitrate: number;
  readonly packetsLost: number;
  readonly packetsRetransmitted: number;
}

export function describeRtpStats(stats: readonly RtpDiagnosticStat[]) {
  return stats.slice(0, 16).map((entry) => ({
    type: entry.type,
    timestamp: entry.timestamp,
    ssrc: entry.ssrc,
    byteCount: entry.byteCount,
    packetCount: entry.packetCount,
    bitrate: entry.bitrate,
    packetsLost: entry.packetsLost,
    packetsRetransmitted: entry.packetsRetransmitted,
  }));
}
