interface RtpByteStat {
  readonly type: string;
  readonly ssrc: number;
  readonly timestamp: number;
  readonly byteCount: number;
}

interface RtpByteCounter {
  readonly bytes: number;
  readonly timestamp: number;
}

export type RtpByteCounters = ReadonlyMap<number, RtpByteCounter>;

export function collectRtpByteCounters(
  stats: readonly RtpByteStat[],
  direction: "inbound-rtp" | "outbound-rtp",
  previous: RtpByteCounters,
): { counters: RtpByteCounters; delta: number } | undefined {
  const observed = new Map<number, RtpByteStat>();
  for (const entry of stats) {
    if (entry.type !== direction) continue;
    if (
      !Number.isSafeInteger(entry.ssrc) ||
      entry.ssrc < 0 ||
      entry.ssrc > 0xffff_ffff ||
      !Number.isFinite(entry.timestamp) ||
      entry.timestamp < 0 ||
      !Number.isSafeInteger(entry.byteCount) ||
      entry.byteCount < 0
    )
      throw new Error("RTP usage statistics require a valid SSRC, timestamp and byte counter");
    const duplicate = observed.get(entry.ssrc);
    if (
      !duplicate ||
      entry.timestamp > duplicate.timestamp ||
      (entry.timestamp === duplicate.timestamp && entry.byteCount > duplicate.byteCount)
    )
      observed.set(entry.ssrc, entry);
  }

  let delta = 0;
  let updated = false;
  const counters = new Map(previous);
  for (const [ssrc, entry] of observed) {
    const baseline = previous.get(ssrc);
    if (
      baseline &&
      (entry.timestamp < baseline.timestamp ||
        (entry.timestamp === baseline.timestamp && entry.byteCount <= baseline.bytes))
    )
      continue;
    const increment =
      !baseline || entry.byteCount < baseline.bytes
        ? entry.byteCount
        : entry.byteCount - baseline.bytes;
    delta += increment;
    if (!Number.isSafeInteger(delta)) throw new Error("RTP usage delta exceeds a safe integer");
    counters.set(ssrc, { bytes: entry.byteCount, timestamp: entry.timestamp });
    updated = true;
  }
  return updated ? { counters, delta } : undefined;
}
