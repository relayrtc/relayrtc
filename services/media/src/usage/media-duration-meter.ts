import { randomUUID } from "node:crypto";
import { persistUsageSample } from "./usage-sample-batch.js";
import { usageMediaDurationMetrics } from "@relayrtc/types";
import type { MediaUsageMetricsStore } from "./usage-metrics-store.js";

type DurationMetric = "audioParticipantSeconds" | "videoParticipantSeconds" | "screenShareSeconds";
interface DurationState {
  tracks: Set<string>;
  metric: DurationMetric;
  sampledAt: number;
  seconds: number;
  pending?: { id: string; seconds: number; occurredAt: Date };
  recording?: Promise<void> | undefined;
}

export class MediaDurationMeter {
  readonly #groups = new Map<string, DurationState>();
  readonly #tracks = new Map<string, string[]>();
  constructor(private readonly store: MediaUsageMetricsStore) {}

  start(trackId: string, participantId: string, trackType: string, at = Date.now()) {
    if (this.#tracks.has(trackId)) return;
    if (!Object.hasOwn(usageMediaDurationMetrics, trackType))
      throw new Error(`Unsupported usage track type: ${trackType}`);
    const metrics = usageMediaDurationMetrics[trackType as keyof typeof usageMediaDurationMetrics];
    const keys = metrics.map((metric) => JSON.stringify([participantId, metric]));
    this.#tracks.set(trackId, keys);
    metrics.forEach((metric) => {
      const key = JSON.stringify([participantId, metric]);
      const group = this.#groups.get(key) ?? {
        tracks: new Set<string>(),
        metric,
        sampledAt: at,
        seconds: 0,
      };
      this.#accrue(group, at);
      group.tracks.add(trackId);
      this.#groups.set(key, group);
    });
  }

  stop(trackId: string, at = Date.now()) {
    for (const key of this.#tracks.get(trackId) ?? []) {
      const group = this.#groups.get(key);
      if (!group) continue;
      this.#accrue(group, at);
      group.tracks.delete(trackId);
    }
    this.#tracks.delete(trackId);
  }

  #accrue(group: DurationState, at: number) {
    if (group.tracks.size > 0) group.seconds += Math.max(0, at - group.sampledAt) / 1000;
    group.sampledAt = Math.max(at, group.sampledAt);
  }

  async flush(roomId: string, at = Date.now(), terminal = false) {
    await Promise.all(
      [...this.#groups.entries()].map(async ([key, group]) => {
        this.#accrue(group, at);
        if (group.recording) {
          if (!terminal) return group.recording;
          await group.recording.catch(() => undefined);
        }
        if (!group.pending && group.seconds <= 0) {
          if (group.tracks.size === 0) this.#groups.delete(key);
          return;
        }
        group.recording = (async () => {
          for (let attempt = 0; attempt < (terminal ? 2 : 1); attempt++) {
            if (!group.pending && group.seconds <= 0) break;
            group.pending ??= {
              id: randomUUID(),
              seconds: group.seconds,
              occurredAt: new Date(at),
            };
            const pending = group.pending;
            await persistUsageSample(
              this.store,
              roomId,
              pending.id,
              { [group.metric]: pending.seconds },
              pending.occurredAt,
            );
            group.seconds = Math.max(0, group.seconds - pending.seconds);
            delete group.pending;
          }
          if (group.tracks.size === 0 && group.seconds === 0 && this.#groups.get(key) === group)
            this.#groups.delete(key);
        })().finally(() => {
          group.recording = undefined;
        });
        return group.recording;
      }),
    );
  }
}
