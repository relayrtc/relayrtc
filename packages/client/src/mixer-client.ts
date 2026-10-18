import type { MixerResource, MixerOperation, MixerCommandResult } from "@relayrtc/types";
export interface MixerCommandContext {
  signal: AbortSignal;
  idempotencyKey: string;
}
export interface MixerClientOptions {
  getMixer: (signal: AbortSignal) => Promise<MixerResource | null>;
  getOperation?: (operationId: string, signal: AbortSignal) => Promise<MixerOperation>;
  activateScene?: (context: MixerCommandContext) => Promise<MixerCommandResult>;
  stop?: (context: MixerCommandContext) => Promise<MixerCommandResult>;
  pollIntervalMs?: number;
}
export interface MixerSnapshot {
  mixer: MixerResource | null;
  operation: MixerOperation | null;
  pending: "activateScene" | "stop" | null;
  error: Error | null;
}
const initial: MixerSnapshot = { mixer: null, operation: null, pending: null, error: null };
export class MixerClient {
  private snapshot = initial;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private polling = false;
  private listeners = new Set<() => void>();
  private keys = new Map<string, string>();
  private readonly interval: number;
  constructor(private readonly options: MixerClientOptions) {
    this.interval = options.pollIntervalMs ?? 2500;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("Invalid mixer polling interval");
  }
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(next: MixerSnapshot) {
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
    this.emit(initial);
  }
  refresh = async () => {
    const controller = this.controller;
    if (!controller || this.polling) return;
    this.polling = true;
    clearTimeout(this.timer);
    const revision = this.revision;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        mixer = await this.options.getMixer(signal),
        current = this.snapshot.operation;
      const operation =
        current?.status === "pending" && this.options.getOperation
          ? await this.options.getOperation(current.id, signal)
          : current;
      if (this.controller === controller && !signal.aborted && this.revision === revision)
        this.emit({ ...this.snapshot, mixer, operation, error: null });
    } catch {
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        this.revision === revision
      )
        this.emit({ ...this.snapshot, error: new Error("Mixer status is unavailable.") });
    } finally {
      this.polling = false;
      if (this.controller && !this.controller.signal.aborted)
        this.timer = setTimeout(() => {
          void this.refresh();
        }, this.interval);
    }
  };
  private async command(kind: "activateScene" | "stop") {
    const controller = this.controller,
      callback = this.options[kind];
    if (!controller || !callback || this.snapshot.pending) return;
    this.revision++;
    this.emit({ ...this.snapshot, pending: kind, error: null });
    const key = this.keys.get(kind) ?? crypto.randomUUID();
    this.keys.set(kind, key);
    try {
      const result = await callback({
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        idempotencyKey: key,
      });
      if (this.controller === controller && !controller.signal.aborted) {
        this.keys.delete(kind);
        this.revision++;
        this.emit({ mixer: result.mixer, operation: result.operation, pending: null, error: null });
      }
    } catch {
      if (this.controller === controller && !controller.signal.aborted)
        this.emit({
          ...this.snapshot,
          pending: null,
          error: new Error("Mixer command could not be confirmed. Retry the same request."),
        });
    }
  }
  activateScene = () => this.command("activateScene");
  stop = () => this.command("stop");
}
