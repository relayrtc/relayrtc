export interface OutputSource {
  sessionId: string;
  generation: number;
}
export interface OutputHealth {
  live: boolean;
  bytesObserved: number;
  droppedFrames?: number;
}
export interface OutputAdapter {
  connect(signal: AbortSignal): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  health(signal: AbortSignal): Promise<OutputHealth>;
  report(): OutputHealth;
  stop(): Promise<void>;
}

/** HLS is packaged from the canonical program by Phase 0, not re-encoded per run.
 * This independently leased attachment checks complete media through the protected
 * origin. RTMP destination adapters own separate output processes; recording remains a later extension. */
export class HlsProgramAdapter implements OutputAdapter {
  private latest: OutputHealth = { live: false, bytesObserved: 0 };
  private lastReady = 0;
  constructor(
    private readonly source: OutputSource,
    private readonly read: (
      signal: AbortSignal,
    ) => Promise<{ sourceSessionId: string; sourceGeneration: number; bytesObserved: number }>,
  ) {}
  async connect(signal: AbortSignal): Promise<void> {
    await this.health(signal);
  }
  start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return Promise.resolve();
  }
  async health(signal: AbortSignal): Promise<OutputHealth> {
    try {
      const sample = await this.read(signal);
      if (
        sample.sourceSessionId !== this.source.sessionId ||
        sample.sourceGeneration !== this.source.generation
      )
        throw new Error("OUTPUT_SOURCE_CHANGED");
      this.lastReady = Date.now();
      this.latest = { live: true, bytesObserved: sample.bytesObserved };
      return this.latest;
    } catch (error) {
      this.latest = { live: false, bytesObserved: 0 };
      throw error;
    }
  }
  report(): OutputHealth {
    return Date.now() - this.lastReady <= 8000 ? this.latest : { live: false, bytesObserved: 0 };
  }
  stop(): Promise<void> {
    this.latest = { live: false, bytesObserved: 0 };
    return Promise.resolve();
  }
}
