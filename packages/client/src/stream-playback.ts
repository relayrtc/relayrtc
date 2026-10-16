/** Application-authorized playback. These callbacks must never use a management key in a browser. */
export interface StreamPlaybackMetadata {
  streamId: string;
  sourceSessionId: string | null;
  generation: number | null;
  state: "ready" | "starting" | "live" | "reconnecting" | "stopping" | "ended" | "failed";
}
export interface StreamPlaybackGrant {
  url: string;
  expiresAt: string;
  token?: string;
}
export interface StreamPlaybackOptions {
  getPlayback: (signal: AbortSignal) => Promise<StreamPlaybackMetadata>;
  getGrant: (signal: AbortSignal) => Promise<StreamPlaybackGrant>;
  pollIntervalMs?: number;
}
export interface StreamPlaybackSnapshot {
  playback: StreamPlaybackMetadata | null;
  grant: StreamPlaybackGrant | null;
  error: Error | null;
}
const initial: StreamPlaybackSnapshot = { playback: null, grant: null, error: null };

export class StreamPlaybackClient {
  private snapshot: StreamPlaybackSnapshot = initial;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private renew = false;
  private interval: number;
  constructor(private readonly options: StreamPlaybackOptions) {
    this.interval = options.pollIntervalMs ?? 5000;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("pollIntervalMs must be between 1000 and 60000");
  }
  getSnapshot = (): StreamPlaybackSnapshot => this.snapshot;
  getServerSnapshot = (): StreamPlaybackSnapshot => initial;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.refresh();
  }
  refresh = (renewGrant = false): Promise<void> => {
    this.renew ||= renewGrant;
    if (this.pending) return this.pending;
    const controller = this.controller;
    if (!controller) return Promise.resolve();
    clearTimeout(this.timer);
    this.pending = this.update(controller).finally(() => {
      this.pending = undefined;
      if (this.controller === controller && !controller.signal.aborted) {
        const expires = Date.parse(this.snapshot.grant?.expiresAt ?? "") - Date.now() - 20000;
        const next = this.renew
          ? 0
          : Number.isFinite(expires) && expires > 0
            ? Math.min(this.interval, expires)
            : this.interval;
        this.timer = setTimeout(() => {
          void this.refresh();
        }, next);
      } else if (this.controller) void this.refresh();
    });
    return this.pending;
  };
  private async update(controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    try {
      const playback = await this.options.getPlayback(signal);
      if (
        !["ready", "starting", "live", "reconnecting", "stopping", "ended", "failed"].includes(
          playback.state,
        )
      )
        throw new Error("Invalid playback metadata");
      const previous = this.snapshot;
      const previousSession = previous.playback?.sourceSessionId;
      const previousGeneration = previous.playback?.generation;
      const changed =
        playback.sourceSessionId !== previousSession || playback.generation !== previousGeneration;
      let grant = previous.grant;
      const requested = this.renew;
      this.renew = false;
      if (playback.state !== "live") grant = null;
      else if (changed || requested || !grant || Date.parse(grant.expiresAt) - Date.now() < 20000) {
        grant = await this.options.getGrant(signal);
        const url = new URL(grant.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          !Number.isFinite(Date.parse(grant.expiresAt)) ||
          Date.parse(grant.expiresAt) <= Date.now()
        )
          throw new Error("Invalid playback grant");
      }
      if (!controller.signal.aborted && this.controller === controller)
        this.publish({ playback, grant, error: null });
    } catch {
      if (!controller.signal.aborted && this.controller === controller) {
        // Never surface authenticated URLs or endpoint error bodies.
        const grant =
          this.snapshot.grant && Date.parse(this.snapshot.grant.expiresAt) > Date.now()
            ? this.snapshot.grant
            : null;
        this.publish({
          ...this.snapshot,
          grant,
          error: new Error("Playback is unavailable. Check your access or try again."),
        });
      }
    }
  }
  private publish(snapshot: StreamPlaybackSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    this.renew = false;
    this.publish(initial);
  }
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }
}

/** Optional engine adapter, for example hls.js. Return a complete teardown function. */
export type HlsEngineFactory = (
  media: HTMLVideoElement,
  url: string,
  onError: () => void,
  onReady: () => void,
) => () => void;

export interface BroadcastPlaybackOptions {
  autoPlay?: boolean;
  createHlsEngine?: HlsEngineFactory;
  onState?: (state: BroadcastPlaybackState) => void;
}
export type BroadcastPlaybackState =
  "loading" | "playing" | "paused" | "blocked" | "unavailable" | "unsupported" | "error";

/** Binds private HLS to a media element and tears down all media and subscriptions. */
export function attachBroadcastPlayback(
  media: HTMLVideoElement,
  client: StreamPlaybackClient,
  options: BroadcastPlaybackOptions = {},
): () => void {
  let detach: (() => void) | undefined;
  let currentUrl: string | undefined;
  let active = true;
  let lastRecovery = 0;
  let shouldPlay = options.autoPlay !== false;
  const state = (value: BroadcastPlaybackState) => {
    if (active) options.onState?.(value);
  };
  const play = () => {
    if (active && shouldPlay)
      void media.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        state(
          error instanceof DOMException && error.name === "NotAllowedError" ? "blocked" : "error",
        );
      });
  };
  const error = () => {
    if (!active) return;
    state("error");
    if (Date.now() - lastRecovery > 5000) {
      lastRecovery = Date.now();
      void client.refresh(true);
    }
  };
  const playing = () => {
    state("playing");
  };
  const waiting = () => {
    state("loading");
  };
  const paused = () => {
    state("paused");
  };
  media.addEventListener("playing", playing);
  media.addEventListener("waiting", waiting);
  media.addEventListener("pause", paused);
  media.addEventListener("error", error);
  media.addEventListener("canplay", play);
  const clear = () => {
    detach?.();
    detach = undefined;
    media.pause();
    media.removeAttribute("src");
    media.load();
  };
  const update = () => {
    const snapshot = client.getSnapshot();
    const url = snapshot.grant?.url;
    if (url === currentUrl) {
      if (!url) state(snapshot.error ? "error" : "unavailable");
      return;
    }
    if (currentUrl) shouldPlay = !media.paused;
    currentUrl = url;
    clear();
    if (!url) {
      state(snapshot.error ? "error" : "unavailable");
      return;
    }
    state("loading");
    if (media.canPlayType("application/vnd.apple.mpegurl")) {
      media.src = url;
      media.load();
    } else if (options.createHlsEngine) {
      try {
        detach = options.createHlsEngine(media, url, error, play);
      } catch {
        state("unsupported");
      }
    } else state("unsupported");
  };
  const unsubscribe = client.subscribe(update);
  update();
  return () => {
    active = false;
    unsubscribe();
    media.removeEventListener("playing", playing);
    media.removeEventListener("waiting", waiting);
    media.removeEventListener("pause", paused);
    media.removeEventListener("error", error);
    media.removeEventListener("canplay", play);
    clear();
  };
}
