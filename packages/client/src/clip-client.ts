import type { ClipResource } from "@relayrtc/types";
export interface ClipCommandContext {
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface ClipClientOptions {
  getClip: (signal: AbortSignal) => Promise<ClipResource | null>;
  create?: (context: ClipCommandContext) => Promise<ClipResource>;
  publish?: (context: ClipCommandContext) => Promise<ClipResource>;
  delete?: (context: ClipCommandContext) => Promise<ClipResource>;
  pollIntervalMs?: number;
}
export interface ClipSnapshot {
  clip: ClipResource | null;
  pending: "create" | "publish" | "delete" | null;
  error: Error | null;
}
const initial: ClipSnapshot = { clip: null, pending: null, error: null };
/** Application callbacks authorize the caller. This client never handles management keys. */
export class ClipClient {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private polling = false;
  private commandKeys = new Map<string, string>();
  private interval: number;
  constructor(private readonly options: ClipClientOptions) {
    this.interval = options.pollIntervalMs ?? 2500;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("Invalid clip poll interval");
  }
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(next: ClipSnapshot) {
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
    clearTimeout(this.timer);
    this.polling = true;
    const revision = this.revision;
    try {
      const clip = await this.options.getClip(
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.emit({ ...this.snapshot, clip, error: null });
    } catch {
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.emit({ ...this.snapshot, error: new Error("Clip status is unavailable.") });
    } finally {
      this.polling = false;
      if (this.controller && !this.controller.signal.aborted)
        this.timer = setTimeout(() => {
          void this.refresh();
        }, this.interval);
    }
  };
  private async command(kind: "create" | "publish" | "delete") {
    const controller = this.controller,
      callback = this.options[kind];
    if (!controller || !callback || this.snapshot.pending) return;
    this.revision++;
    this.emit({ ...this.snapshot, pending: kind, error: null });
    const key = this.commandKeys.get(kind) ?? crypto.randomUUID();
    this.commandKeys.set(kind, key);
    try {
      const clip = await callback({
        idempotencyKey: key,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      if (this.controller === controller && !controller.signal.aborted) {
        this.commandKeys.delete(kind);
        this.revision++;
        this.emit({ clip, pending: null, error: null });
      }
    } catch {
      if (this.controller === controller && !controller.signal.aborted)
        this.emit({
          ...this.snapshot,
          pending: null,
          error: new Error(
            "The clip command could not be confirmed. Retry to check the same command.",
          ),
        });
    }
  }
  create = () => this.command("create");
  publish = () => this.command("publish");
  delete = () => this.command("delete");
}
