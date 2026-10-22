import { StreamingBackoff } from "./streaming-request-error.js";

export type BroadcastState =
  | "created"
  | "waiting_for_source"
  | "starting"
  | "live"
  | "reconnecting"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";
export interface BroadcastStatus {
  id: string;
  streamId: string;
  state: BroadcastState;
  version: number;
  sourceSessionId: string | null;
  sourceGeneration: number | null;
  lastError: string | null;
}
export interface BroadcastOutputStatus {
  id: string;
  broadcastId: string;
  kind: string;
  destinationId?: string | null;
  destinationName?: string | null;
  outputSeconds?: number;
  bytes?: number;
  bitrate?: number;
  droppedFrames?: number;
  transcodeSeconds?: number;
  state: "queued" | "running" | "retry" | "stopping" | "completed" | "failed" | "cancelled";
  attempts: number;
  lastError: string | null;
}
export interface BroadcastOperationStatus {
  id: string;
  status: "pending" | "completed" | "failed";
  errorCode: string | null;
}
export interface BroadcastClientOptions {
  getBroadcast: (signal: AbortSignal) => Promise<BroadcastStatus>;
  getOutputs: (signal: AbortSignal) => Promise<{ data: BroadcastOutputStatus[] }>;
  getOperation: (operationId: string, signal: AbortSignal) => Promise<BroadcastOperationStatus>;
  start?: (
    input: { version: number; idempotencyKey: string },
    signal: AbortSignal,
  ) => Promise<BroadcastOperationStatus>;
  stop?: (
    input: { version: number; idempotencyKey: string },
    signal: AbortSignal,
  ) => Promise<BroadcastOperationStatus>;
  retryOutput?: (
    outputId: string,
    input: { version: number; idempotencyKey: string },
    signal: AbortSignal,
  ) => Promise<BroadcastOperationStatus>;
  pollIntervalMs?: number;
}
export interface BroadcastSnapshot {
  broadcast: BroadcastStatus | null;
  outputs: BroadcastOutputStatus[];
  operation: BroadcastOperationStatus | null;
  pending: "start" | "stop" | "retry" | null;
  pendingOutputId: string | null;
  error: Error | null;
}
const initial: BroadcastSnapshot = {
  broadcast: null,
  outputs: [],
  operation: null,
  pending: null,
  pendingOutputId: null,
  error: null,
};
const states = [
  "created",
  "waiting_for_source",
  "starting",
  "live",
  "reconnecting",
  "degraded",
  "stopping",
  "stopped",
  "failed",
];
export class BroadcastClient {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: Promise<void> | undefined;
  private controlling = false;
  private revision = 0;
  private refreshAgain = false;
  private interval: number;
  private readonly backoff = new StreamingBackoff();
  private retryCommand:
    | {
        kind: "start" | "stop" | "retry";
        outputId?: string;
        version: number;
        idempotencyKey: string;
      }
    | undefined;
  constructor(private readonly options: BroadcastClientOptions) {
    this.interval = options.pollIntervalMs ?? 3000;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("pollIntervalMs must be between 1000 and 60000");
  }
  getSnapshot = (): BroadcastSnapshot => this.snapshot;
  getServerSnapshot = (): BroadcastSnapshot => initial;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  connect(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.refresh();
  }
  refresh = (discardFailedCommand = false): Promise<void> => {
    if (discardFailedCommand) this.retryCommand = undefined;
    if (this.reading) {
      this.refreshAgain = true;
      return this.reading;
    }
    const controller = this.controller;
    if (!controller) return Promise.resolve();
    clearTimeout(this.timer);
    if (this.backoff.remaining() > 0) {
      this.timer = setTimeout(() => { void this.refresh(); }, this.backoff.remaining());
      return Promise.resolve();
    }
    this.reading = this.read(controller).finally(() => {
      this.reading = undefined;
      const next = this.backoff.delay(this.refreshAgain ? 0 : this.interval);
      this.refreshAgain = false;
      if (this.controller === controller && !controller.signal.aborted)
        this.timer = setTimeout(() => {
          void this.refresh();
        }, next);
      else if (this.controller) void this.refresh();
    });
    return this.reading;
  };
  private async read(controller: AbortController): Promise<void> {
    const revision = this.revision;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    try {
      const [broadcast, outputs] = await Promise.all([
        this.options.getBroadcast(signal),
        this.options.getOutputs(signal),
      ]);
      if (!states.includes(broadcast.state) || !Array.isArray(outputs.data))
        throw new Error("Invalid broadcast response");
      const previousOperation = this.snapshot.operation;
      const operation =
        previousOperation?.status === "pending"
          ? await this.options.getOperation(previousOperation.id, signal)
          : previousOperation;
      if (
        !controller.signal.aborted &&
        this.controller === controller &&
        revision === this.revision
      ) {
        this.backoff.succeed();
        this.publish({
          ...this.snapshot,
          broadcast,
          outputs: outputs.data,
          operation:
            this.snapshot.operation === previousOperation ? operation : this.snapshot.operation,
          error: this.retryCommand ? this.snapshot.error : null,
        });
      }
    } catch (error) {
      if (
        !controller.signal.aborted &&
        this.controller === controller &&
        revision === this.revision
      )
        this.publish({
          ...this.snapshot,
          error: this.backoff.fail("Broadcast status is unavailable. Check access or retry.", error, this.interval),
        });
    }
  }
  start = (): Promise<void> => this.command("start");
  stop = (): Promise<void> => this.command("stop");
  retryOutput = (outputId: string): Promise<void> => this.command("retry", outputId);
  private async command(kind: "start" | "stop" | "retry", outputId?: string): Promise<void> {
    const retry = this.options.retryOutput;
    const controller = this.controller,
      broadcast = this.snapshot.broadcast,
      callback =
        kind === "retry"
          ? retry && outputId
            ? (input: { version: number; idempotencyKey: string }, signal: AbortSignal) =>
                retry(outputId, input, signal)
            : undefined
          : this.options[kind];
    if (!controller || !broadcast || !callback || this.controlling || this.backoff.remaining() > 0) return;
    this.controlling = true;
    this.revision++;
    this.publish({
      ...this.snapshot,
      pending: kind,
      pendingOutputId: outputId ?? null,
      error: null,
    });
    const previous = this.retryCommand;
    const input =
      previous?.kind === kind && previous.outputId === outputId
        ? previous
        : {
            kind,
            ...(outputId ? { outputId } : {}),
            version: broadcast.version,
            idempotencyKey: crypto.randomUUID(),
          };
    this.retryCommand = input;
    try {
      const operation = await callback(
        { version: input.version, idempotencyKey: input.idempotencyKey },
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      if (!controller.signal.aborted && this.controller === controller) {
        this.revision++;
        this.retryCommand = undefined;
        this.backoff.succeed();
        this.publish({
          ...this.snapshot,
          pending: null,
          pendingOutputId: null,
          operation,
          error: null,
        });
        await this.refresh();
      }
    } catch (error) {
      this.revision++;
      if (!controller.signal.aborted && this.controller === controller)
        this.publish({
          ...this.snapshot,
          pending: null,
          pendingOutputId: null,
          error: this.backoff.fail("Broadcast command failed. Retry the same action or reload status.", error, this.interval),
        });
    } finally {
      this.controlling = false;
    }
  }
  private publish(snapshot: BroadcastSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  disconnect(): void {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    this.retryCommand = undefined;
    this.refreshAgain = false;
    this.backoff.reset();
    this.publish(initial);
  }
  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }
}
