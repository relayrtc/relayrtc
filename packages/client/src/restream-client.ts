import type { RestreamDetail } from "@relayrtc/types";
export interface RestreamSourceOptions {
  getSource: (signal: AbortSignal) => Promise<RestreamDetail>;
  command?: (
    action: "probe" | "start" | "stop",
    input: { idempotencyKey: string },
    signal: AbortSignal,
  ) => Promise<RestreamDetail>;
  pollIntervalMs?: number;
}
export interface RestreamSourceSnapshot {
  source: RestreamDetail | null;
  pending: "probe" | "start" | "stop" | null;
  error: Error | null;
}
const initial: RestreamSourceSnapshot = { source: null, pending: null, error: null };
/** Uses application callbacks; no management key or upstream credential belongs in the browser. */
export class RestreamSourceClient {
  private snapshot = initial;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private revision = 0;
  private polling: AbortController | undefined;
  private keys = new Map<string, string>();
  private readonly interval: number;
  constructor(private readonly options: RestreamSourceOptions) {
    this.interval = options.pollIntervalMs ?? 2500;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("Invalid source poll interval");
  }
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: RestreamSourceSnapshot) {
    this.snapshot = value;
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
    if (!controller || this.polling === controller) return;
    this.polling = controller;
    clearTimeout(this.timer);
    const revision = this.revision;
    try {
      const source = await this.options.getSource(
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (
        this.controller === controller &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.publish({ ...this.snapshot, source, error: null });
    } catch {
      if (this.controller === controller && !controller.signal.aborted)
        this.publish({ ...this.snapshot, error: new Error("Source status is unavailable") });
    } finally {
      if (this.polling === controller) this.polling = undefined;
      if (this.controller === controller && !controller.signal.aborted)
        this.timer = setTimeout(() => void this.refresh(), this.interval);
    }
  };
  command = async (action: "probe" | "start" | "stop") => {
    const controller = this.controller;
    if (!controller || this.snapshot.pending || !this.options.command)
      throw new Error("Source control is unavailable");
    const key = this.keys.get(action) ?? crypto.randomUUID();
    this.keys.set(action, key);
    this.revision++;
    this.publish({ ...this.snapshot, pending: action, error: null });
    try {
      const source = await this.options.command(
        action,
        { idempotencyKey: key },
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      this.keys.delete(action);
      this.revision++;
      if (this.controller === controller && !controller.signal.aborted)
        this.publish({
          ...this.snapshot,
          source:
            this.snapshot.source &&
            Date.parse(this.snapshot.source.updatedAt) > Date.parse(source.updatedAt)
              ? this.snapshot.source
              : source,
          pending: null,
        });
    } catch {
      if (this.controller === controller && !controller.signal.aborted)
        this.publish({
          ...this.snapshot,
          pending: null,
          error: new Error(
            "Source command could not be confirmed; retry to check the same request",
          ),
        });
    }
  };
}
