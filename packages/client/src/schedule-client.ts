import type { ScheduledBroadcast, ScheduleTiming, ScheduledPlayback } from "@relayrtc/types";
export interface ScheduleCommand {
  version: number;
  idempotencyKey: string;
}
export interface ScheduledBroadcastOptions {
  getSchedule: (signal: AbortSignal) => Promise<ScheduledBroadcast>;
  getPlayback?: (signal: AbortSignal) => Promise<ScheduledPlayback>;
  update?: (
    input: ScheduleCommand & { timing: ScheduleTiming },
    signal: AbortSignal,
  ) => Promise<ScheduledBroadcast>;
  cancel?: (input: ScheduleCommand, signal: AbortSignal) => Promise<ScheduledBroadcast>;
  startNow?: (input: ScheduleCommand, signal: AbortSignal) => Promise<ScheduledBroadcast>;
  pollIntervalMs?: number;
}
export interface ScheduledBroadcastSnapshot {
  schedule: ScheduledBroadcast | null;
  playback: ScheduledPlayback | null;
  pending: "update" | "cancel" | "startNow" | null;
  error: Error | null;
  serverOffsetMs: number;
}
const initial: ScheduledBroadcastSnapshot = {
  schedule: null,
  playback: null,
  pending: null,
  error: null,
  serverOffsetMs: 0,
};
export class ScheduledBroadcastClient {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private revision = 0;
  private keys = new Map<string, { key: string; version: number }>();
  private interval: number;
  constructor(private options: ScheduledBroadcastOptions) {
    this.interval = options.pollIntervalMs ?? 2500;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("Invalid schedule poll interval");
  }
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: ScheduledBroadcastSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  connect() {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.refresh();
  }
  disconnect() {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    this.revision++;
    this.publish(initial);
  }
  refresh = async () => {
    const controller = this.controller;
    if (!controller || this.polling) return;
    this.polling = true;
    clearTimeout(this.timer);
    const revision = this.revision;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    try {
      const schedule = await this.options.getSchedule(signal);
      let playback: ScheduledPlayback | null = null;
      if (this.options.getPlayback)
        try {
          playback = await this.options.getPlayback(signal);
        } catch {
          playback = null;
        }
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.publish({
          ...this.snapshot,
          schedule,
          playback,
          error: null,
          serverOffsetMs: playback ? Date.parse(playback.serverTime) - Date.now() : 0,
        });
    } catch {
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.publish({ ...this.snapshot, error: new Error("Schedule status is unavailable.") });
    } finally {
      this.polling = false;
      if (this.controller && !this.controller.signal.aborted)
        this.timer = setTimeout(() => {
          void this.refresh();
        }, this.interval);
    }
  };
  private async command(kind: "update" | "cancel" | "startNow", timing?: ScheduleTiming) {
    const controller = this.controller,
      schedule = this.snapshot.schedule;
    if (!controller || !schedule || this.snapshot.pending) return;
    const identity = JSON.stringify({
        kind,
        timing,
        scheduleId: schedule.id,
      }),
      attempt = this.keys.get(identity) ?? { key: crypto.randomUUID(), version: schedule.version };
    this.keys.set(identity, attempt);
    const callback = this.options[kind];
    if (!callback) return;
    this.revision++;
    this.publish({ ...this.snapshot, pending: kind, error: null });
    try {
      const input = { version: attempt.version, idempotencyKey: attempt.key },
        signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      const updated =
        kind === "update" && timing && this.options.update
          ? await this.options.update({ ...input, timing }, signal)
          : kind === "cancel" && this.options.cancel
            ? await this.options.cancel(input, signal)
            : kind === "startNow" && this.options.startNow
              ? await this.options.startNow(input, signal)
              : schedule;
      if (this.controller === controller && !controller.signal.aborted) {
        this.keys.delete(identity);
        this.revision++;
        this.publish({
          ...this.snapshot,
          schedule:
            this.snapshot.schedule?.id === updated.id &&
            this.snapshot.schedule.version > updated.version
              ? this.snapshot.schedule
              : updated,
          playback: null,
          pending: null,
          error: null,
        });
      }
    } catch {
      if (this.controller === controller && !controller.signal.aborted)
        this.publish({
          ...this.snapshot,
          pending: null,
          error: new Error(
            "The schedule command could not be confirmed. Retry the same command or refresh its status.",
          ),
        });
    }
  }
  update = (timing: ScheduleTiming) => this.command("update", timing);
  cancel = () => this.command("cancel");
  startNow = () => this.command("startNow");
}
