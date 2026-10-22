import type { RecordingResource } from "@relayrtc/types";
import { StreamingBackoff } from "./streaming-request-error.js";
export interface RecordingCommandContext {
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface RecordingClientOptions {
  getRecording: (signal: AbortSignal) => Promise<RecordingResource | null>;
  start?: (context: RecordingCommandContext) => Promise<RecordingResource>;
  stop?: (context: RecordingCommandContext) => Promise<RecordingResource>;
  delete?: (context: RecordingCommandContext) => Promise<RecordingResource>;
  pollIntervalMs?: number;
}
export interface RecordingSnapshot {
  recording: RecordingResource | null;
  pending: "start" | "stop" | "delete" | null;
  error: Error | null;
}
const initial: RecordingSnapshot = { recording: null, pending: null, error: null };
/** Application callbacks authorize the caller. This client never handles management keys. */
export class RecordingClient {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private polling = false;
  private commandKeys = new Map<string, string>();
  private interval: number;
  private readonly backoff = new StreamingBackoff();
  constructor(private readonly options: RecordingClientOptions) {
    this.interval = options.pollIntervalMs ?? 2500;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("Invalid recording poll interval");
  }
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: RecordingSnapshot) {
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
    this.backoff.reset();
    this.publish(initial);
  }
  refresh = async () => {
    const controller = this.controller;
    if (!controller || this.polling) return;
    clearTimeout(this.timer);
    if (this.backoff.remaining() > 0) {
      this.timer = setTimeout(() => { void this.refresh(); }, this.backoff.remaining());
      return;
    }
    this.polling = true;
    const revision = this.revision;
    try {
      const recording = await this.options.getRecording(
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        revision === this.revision
      ) {
        this.backoff.succeed();
        this.publish({ ...this.snapshot, recording, error: null });
      }
    } catch (error) {
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.publish({ ...this.snapshot, error: this.backoff.fail("Recording status is unavailable.", error, this.interval) });
    } finally {
      this.polling = false;
      if (this.controller && !this.controller.signal.aborted)
        this.timer = setTimeout(() => {
          void this.refresh();
        }, this.backoff.delay(this.interval));
    }
  };
  private async command(kind: "start" | "stop" | "delete") {
    const controller = this.controller,
      callback = this.options[kind];
    if (!controller || !callback || this.snapshot.pending || this.backoff.remaining() > 0) return;
    this.revision++;
    this.publish({ ...this.snapshot, pending: kind, error: null });
    const key = this.commandKeys.get(kind) ?? crypto.randomUUID();
    this.commandKeys.set(kind, key);
    try {
      const recording = await callback({
        idempotencyKey: key,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      if (this.controller === controller && !controller.signal.aborted) {
        this.commandKeys.delete(kind);
        this.backoff.succeed();
        this.revision++;
        this.publish({ recording, pending: null, error: null });
      }
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted)
        this.publish({
          ...this.snapshot,
          pending: null,
          error: this.backoff.fail(
            "The recording command could not be confirmed. Retry to check the same command.",
            error, this.interval,
          ),
        });
    }
  }
  start = () => this.command("start");
  stop = () => this.command("stop");
  delete = () => this.command("delete");
}
