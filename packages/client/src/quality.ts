export const videoQualityLevels = ["1080p", "720p", "360p", "audio-only"] as const;
export type VideoQualityLevel = (typeof videoQualityLevels)[number];
export interface RtcStreamStats {
  readonly id: string;
  readonly direction: "inbound" | "outbound";
  readonly kind: string | null;
  readonly codec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly framesPerSecond: number | null;
  readonly bytes: number | null;
  readonly packets: number | null;
  readonly packetsLost: number | null;
  readonly timestamp: number;
}
export interface RtcQualityStats {
  readonly availableIncomingBitrate: number | null;
  readonly availableOutgoingBitrate: number | null;
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly jitter: number | null;
  readonly packetsLost: number;
  readonly packetsReceived: number;
  readonly roundTripTime: number | null;
  readonly timestamp: number;
  readonly incomingBitrate?: number | null;
  readonly outgoingBitrate?: number | null;
  readonly packetLossRatio?: number | null;
  readonly stale?: boolean;
  readonly streams?: readonly RtcStreamStats[];
  readonly selectedCandidatePairId?: string | null;
  readonly localCandidateType?: string | null;
  readonly remoteCandidateType?: string | null;
  readonly candidateProtocol?: string | null;
}
export const simulcastEncodings: readonly RTCRtpEncodingParameters[] = [
  { active: true, maxBitrate: 150_000, maxFramerate: 30, rid: "q", scaleResolutionDownBy: 3 },
  { active: true, maxBitrate: 1_500_000, maxFramerate: 30, rid: "h", scaleResolutionDownBy: 1.5 },
  { active: true, maxBitrate: 4_000_000, maxFramerate: 30, rid: "f", scaleResolutionDownBy: 1 },
];
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);
const epoch = (value: unknown): number => {
  const timestamp = numeric(value) ?? 0;
  return timestamp > 0 && timestamp < 1_000_000_000_000 && typeof performance !== "undefined"
    ? performance.timeOrigin + timestamp
    : timestamp;
};
export const normalizeRtcStats = (
  report: RTCStatsReport,
  previous?: RtcQualityStats,
  now = Date.now(),
): RtcQualityStats => {
  const entries = new Map<string, Record<string, unknown>>();
  report.forEach((raw) => {
    const entry = raw as unknown as Record<string, unknown>;
    if (typeof entry.id === "string") entries.set(entry.id, entry);
  });
  const fresh = (entry: Record<string, unknown>): boolean => {
    const timestamp = epoch(entry.timestamp);
    return timestamp > 0 && timestamp <= now + 1000 && now - timestamp <= 10_000;
  };
  const transports = [...entries.values()].filter(
    (entry) => entry.type === "transport" && entry.dtlsState !== "closed" && fresh(entry),
  );
  const activeTransports = new Set(transports.map((entry) => String(entry.id)));
  const selectedIds = new Set(
    transports
      .map((entry) => string(entry.selectedCandidatePairId))
      .filter((id): id is string => id !== null),
  );
  const pairs = [...entries.values()].filter(
    (entry) =>
      entry.type === "candidate-pair" &&
      entry.state === "succeeded" &&
      fresh(entry) &&
      (selectedIds.size > 0 ? selectedIds.has(String(entry.id)) : entry.selected === true),
  );
  const pair = pairs.length === 1 ? pairs[0] : undefined;
  const local = pair ? entries.get(String(pair.localCandidateId)) : undefined;
  const remote = pair ? entries.get(String(pair.remoteCandidateId)) : undefined;
  const streams: RtcStreamStats[] = [];
  let jitter: number | null = null;
  for (const entry of entries.values()) {
    if (
      !fresh(entry) ||
      entry.isRemote ||
      entry.trackIdentifier === "probator" ||
      entry.active === false ||
      (typeof entry.transportId === "string" &&
        activeTransports.size > 0 &&
        !activeTransports.has(entry.transportId)) ||
      (entry.type !== "inbound-rtp" && entry.type !== "outbound-rtp")
    )
      continue;
    const inbound = entry.type === "inbound-rtp";
    const codec = entries.get(String(entry.codecId));
    const value = numeric(entry.jitter);
    if (inbound && value !== null) jitter = Math.max(jitter ?? value, value);
    streams.push({
      id: String(entry.id),
      direction: inbound ? "inbound" : "outbound",
      kind: string(entry.kind) ?? string(entry.mediaType),
      codec: string(codec?.mimeType),
      width: numeric(entry.frameWidth),
      height: numeric(entry.frameHeight),
      framesPerSecond: numeric(entry.framesPerSecond),
      bytes: numeric(inbound ? entry.bytesReceived : entry.bytesSent),
      packets: numeric(inbound ? entry.packetsReceived : entry.packetsSent),
      packetsLost: inbound ? numeric(entry.packetsLost) : null,
      timestamp: epoch(entry.timestamp),
    });
  }
  const sum = (
    direction: RtcStreamStats["direction"],
    key: "bytes" | "packets" | "packetsLost",
  ): number =>
    streams
      .filter((stream) => stream.direction === direction)
      .reduce((total, stream) => total + (stream[key] ?? 0), 0);
  const rate = (direction: RtcStreamStats["direction"]): number | null => {
    const current = streams.filter((stream) => stream.direction === direction);
    if (!current.length || !previous?.streams || previous.stale) return null;
    let result = 0;
    for (const stream of current) {
      const old = previous.streams.find(
        (value) => value.id === stream.id && value.direction === direction,
      );
      const elapsed = old ? stream.timestamp - old.timestamp : 0;
      if (
        !old ||
        elapsed <= 0 ||
        elapsed > 10_000 ||
        stream.bytes === null ||
        old.bytes === null ||
        stream.bytes < old.bytes
      )
        return null;
      result += ((stream.bytes - old.bytes) * 8000) / elapsed;
    }
    return result;
  };
  let lost = 0;
  let received = 0;
  let validLoss = false;
  for (const stream of streams.filter((value) => value.direction === "inbound")) {
    const old = previous?.streams?.find((value) => value.id === stream.id);
    if (!old) continue;
    if (
      old.packetsLost === null ||
      old.packets === null ||
      stream.packetsLost === null ||
      stream.packets === null ||
      stream.timestamp <= old.timestamp ||
      stream.timestamp - old.timestamp > 10_000 ||
      stream.packetsLost < old.packetsLost ||
      stream.packets < old.packets
    )
      continue;
    lost += stream.packetsLost - old.packetsLost;
    received += stream.packets - old.packets;
    validLoss = true;
  }
  return {
    availableIncomingBitrate: numeric(pair?.availableIncomingBitrate),
    availableOutgoingBitrate: numeric(pair?.availableOutgoingBitrate),
    bytesReceived: sum("inbound", "bytes"),
    bytesSent: sum("outbound", "bytes"),
    packetsLost: sum("inbound", "packetsLost"),
    packetsReceived: sum("inbound", "packets"),
    jitter,
    roundTripTime: numeric(pair?.currentRoundTripTime),
    timestamp: Math.max(
      0,
      ...streams.map((stream) => stream.timestamp),
      ...pairs.map((value) => epoch(value.timestamp)),
    ),
    incomingBitrate: rate("inbound"),
    outgoingBitrate: rate("outbound"),
    packetLossRatio: validLoss && lost + received > 0 ? lost / (lost + received) : null,
    stale: pairs.length === 0 && streams.length === 0,
    streams,
    selectedCandidatePairId: string(pair?.id),
    localCandidateType: string(local?.candidateType),
    remoteCandidateType: string(remote?.candidateType),
    candidateProtocol: string(local?.protocol) ?? string(remote?.protocol),
  };
};
