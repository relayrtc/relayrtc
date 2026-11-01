import type { Consumer, Producer } from "mediasoup/types";
import type {
  MediaPriority,
  SelectedVideoQuality,
  SubscriberNetworkStats,
  SubscriberQualityMode,
} from "./quality-controller.js";

export interface VideoLayer {
  quality: Exclude<SelectedVideoQuality, "audio-only">;
  bitrate: number;
  spatialLayer: number;
  temporalLayer: number;
  height?: number | null;
  scaleResolutionDownBy?: number | null;
}
export interface BudgetTrack {
  id: string;
  priority: MediaPriority;
  screen: boolean;
  preference: SubscriberQualityMode;
  layers: readonly VideoLayer[];
  current: SelectedVideoQuality | null;
  currentSpatialLayer?: number;
}
export const qualityRank: Record<SelectedVideoQuality, number> = {
  "audio-only": 0,
  "360p": 1,
  "720p": 2,
  "1080p": 3,
};

export const videoUpgradeHeadroomRatio = 0.1;

export function subscriberBudget(stats: SubscriberNetworkStats | undefined, audioTracks: number) {
  const packetLossRatio =
    stats?.packetLossRatio ??
    (stats && stats.packetsLost + stats.packetsReceived > 0
      ? stats.packetsLost / (stats.packetsLost + stats.packetsReceived)
      : 0);
  const capacity = stats?.availableIncomingBitrate ?? null;
  const audioBitrate = Math.max(64_000, audioTracks * 64_000);
  const blocked = stats?.stale
    ? "stale"
    : packetLossRatio >= 0.2
      ? "packet-loss"
      : (stats?.roundTripTime ?? 0) >= 1
        ? "round-trip-time"
        : null;
  return {
    capacity,
    audioBitrate,
    packetLossRatio,
    statsTimestamp: stats?.timestamp ?? null,
    roundTripTime: stats?.roundTripTime ?? null,
    stale: stats?.stale ?? false,
    blocked,
    videoBitrate: blocked
      ? 0
      : capacity === null
        ? null
        : Math.max(0, capacity * (packetLossRatio >= 0.08 ? 0.65 : 0.85) - audioBitrate),
    upgradeHeadroomRatio: videoUpgradeHeadroomRatio,
  };
}

export function availableVideoLayers(producer: Producer, consumer: Consumer): VideoLayer[] {
  const encodings = producer.rtpParameters.encodings ?? [];
  const first = encodings[0];
  const mode = /^(?:L|S)(\d+)T(\d+)/u.exec(first?.scalabilityMode ?? "");
  const spatial =
    consumer.type === "simulcast"
      ? encodings.length
      : consumer.type === "svc"
        ? Number(mode?.[1] ?? 1)
        : 1;
  const temporal = Math.max(0, Number(mode?.[2] ?? 1) - 1);
  const sourceHeight =
    typeof producer.appData.sourceHeight === "number" &&
    Number.isFinite(producer.appData.sourceHeight) &&
    producer.appData.sourceHeight > 0
      ? producer.appData.sourceHeight
      : null;
  const profiles: VideoLayer[] = [];
  for (let index = 0; index < spatial; index++) {
    const encoding = consumer.type === "simulcast" ? encodings[index] : first;
    const configuredScale = (encoding as { scaleResolutionDownBy?: number } | undefined)
      ?.scaleResolutionDownBy;
    const encodingScale =
      typeof configuredScale === "number" &&
      Number.isFinite(configuredScale) &&
      configuredScale >= 1
        ? configuredScale
        : null;
    const scale =
      consumer.type === "svc"
        ? (encodingScale ?? 1) * 2 ** (spatial - index - 1)
        : (encodingScale ?? (spatial === 1 ? 1 : null));
    const height =
      sourceHeight === null || scale === null ? null : Math.round(sourceHeight / scale);
    const quality =
      height !== null
        ? height > 720
          ? "1080p"
          : height > 360
            ? "720p"
            : "360p"
        : spatial >= 3
          ? index === 0
            ? "360p"
            : index === 1
              ? "720p"
              : "1080p"
          : spatial === 2
            ? index === 0
              ? "360p"
              : "720p"
            : "1080p";
    const base = { "360p": 500_000, "720p": 1_500_000, "1080p": 4_000_000 }[quality];
    const bitrate =
      encoding?.maxBitrate ??
      (consumer.type === "svc" && first?.maxBitrate
        ? first.maxBitrate / 2 ** (spatial - index - 1)
        : base);
    profiles.push({
      quality,
      bitrate,
      spatialLayer: index,
      temporalLayer: temporal,
      height,
      scaleResolutionDownBy: scale,
    });
  }
  return profiles;
}

export function allocateSubscriberBudget(
  tracks: readonly BudgetTrack[],
  stats: SubscriberNetworkStats | undefined,
  audioTracks: number,
): Map<string, VideoLayer | null> {
  const allocation = new Map(tracks.map((track) => [track.id, null as VideoLayer | null]));
  const budget = subscriberBudget(stats, audioTracks);
  if (budget.blocked) return allocation;
  const eligible = (track: BudgetTrack): VideoLayer[] => {
    const preference = track.preference;
    if (preference === "audio-only") return [];
    return track.layers.filter((layer) => {
      if (preference === "auto") return true;
      const ceiling = { "360p": 360, "720p": 720, "1080p": 1080 }[preference];
      return layer.height == null
        ? qualityRank[layer.quality] <= qualityRank[preference]
        : layer.height <= ceiling;
    });
  };
  // Unknown capacity preserves the current layers; it never grants a full budget to each track.
  if (budget.videoBitrate === null) {
    for (const track of tracks) {
      if (track.preference === "audio-only") continue;
      const currentLayer =
        track.currentSpatialLayer ??
        track.layers.find((layer) => layer.quality === track.current)?.spatialLayer ??
        track.layers[0]?.spatialLayer ??
        -1;
      const ceiling = Math.max(currentLayer, track.layers[0]?.spatialLayer ?? -1);
      allocation.set(
        track.id,
        [...eligible(track)].reverse().find((layer) => layer.spatialLayer <= ceiling) ?? null,
      );
    }
    return allocation;
  }
  let remaining = budget.videoBitrate;
  const weight = { high: 3, normal: 2, low: 1 };
  const ordered = [...tracks].sort(
    (left, right) =>
      weight[right.priority] - weight[left.priority] ||
      Number(right.screen) - Number(left.screen) ||
      left.id.localeCompare(right.id),
  );
  // Give each track a base layer before spending the remainder on upgrades.
  for (const track of ordered) {
    const base = eligible(track)[0];
    if (base && base.bitrate <= remaining) {
      allocation.set(track.id, base);
      remaining -= base.bitrate;
    }
  }
  for (const track of ordered) {
    for (const layer of eligible(track)) {
      const current = allocation.get(track.id);
      if (!current || layer.spatialLayer <= current.spatialLayer) continue;
      const extra = layer.bitrate - current.bitrate;
      // Upgrades need headroom; downgrades are immediate when the shared budget shrinks.
      const upgrading =
        track.currentSpatialLayer === undefined
          ? qualityRank[layer.quality] > qualityRank[track.current ?? "audio-only"]
          : layer.spatialLayer > track.currentSpatialLayer;
      const margin = upgrading ? layer.bitrate * videoUpgradeHeadroomRatio : 0;
      if (extra + margin > remaining) break;
      allocation.set(track.id, layer);
      remaining -= extra;
    }
  }
  return allocation;
}
