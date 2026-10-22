import { StreamingBackoff } from "./streaming-request-error.js";

/** Application-authorized playback. These callbacks must never use a management key in a browser. */
export interface StreamPlaybackMetadata {
  streamId: string;
  sourceSessionId: string | null;
  generation: number | null;
  state:
    | "ready"
    | "starting"
    | "live"
    | "reconnecting"
    | "stopping"
    | "ended"
    | "failed"
    | "unavailable";
  startSeconds?: number | null;
  endSeconds?: number | null;
  wallEnd?: string | null;
  broadcastId?: string | null;
}
export interface StreamPlaybackGrant {
  url: string;
  expiresAt: string;
  token?: string;
}
export interface StreamPlaybackOptions {
  mode?: "live" | "vod" | "dvr";
  getPlayback: (signal: AbortSignal) => Promise<StreamPlaybackMetadata>;
  getGrant: (
    signal: AbortSignal,
    playback?: StreamPlaybackMetadata,
  ) => Promise<StreamPlaybackGrant>;
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
  private readonly backoff = new StreamingBackoff();
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
    if (this.backoff.remaining() > 0) {
      this.timer = setTimeout(() => { void this.refresh(); }, this.backoff.remaining());
      return Promise.resolve();
    }
    this.pending = this.update(controller).finally(() => {
      this.pending = undefined;
      if (this.controller === controller && !controller.signal.aborted) {
        const expires = Date.parse(this.snapshot.grant?.expiresAt ?? "") - Date.now() - 20000;
        const next = this.backoff.delay(this.renew
          ? 0
          : Number.isFinite(expires) && expires > 0
            ? Math.min(this.interval, expires)
            : this.interval);
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
        ![
          "ready",
          "starting",
          "live",
          "reconnecting",
          "stopping",
          "ended",
          "failed",
          "unavailable",
        ].includes(playback.state)
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
      if (
        !(this.options.mode === "dvr"
          ? ["live", "ended"].includes(playback.state)
          : playback.state === (this.options.mode === "vod" ? "ready" : "live"))
      )
        grant = null;
      else if (changed || requested || !grant || Date.parse(grant.expiresAt) - Date.now() < 20000) {
        grant = await this.options.getGrant(signal, playback);
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
      if (!controller.signal.aborted && this.controller === controller) {
        this.backoff.succeed();
        this.publish({ playback, grant, error: null });
      }
    } catch (error) {
      if (!controller.signal.aborted && this.controller === controller) {
        // Never surface authenticated URLs or endpoint error bodies.
        const grant =
          this.snapshot.grant && Date.parse(this.snapshot.grant.expiresAt) > Date.now()
            ? this.snapshot.grant
            : null;
        this.publish({
          ...this.snapshot,
          grant,
          error: this.backoff.fail("Playback is unavailable. Check your access or try again.", error, this.interval),
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
    this.backoff.reset();
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
  mode?: "live" | "vod" | "dvr";
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
  let resumeTime = 0;
  let resumeWallTime: number | undefined;
  let previousWallEnd: number | undefined;
  let identity: string | undefined;
  let active = true;
  let lastRecovery = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recovering = false;
  let forceReload = false;
  let hasPlayed = false;
  let attachment = 0;
  let shouldPlay = options.autoPlay !== false;
  const state = (value: BroadcastPlaybackState) => {
    if (active) options.onState?.(value);
  };
  const play = () => {
    const attempt = attachment;
    if (active && shouldPlay)
      void media.play().catch((caught: unknown) => {
        if (!active || attempt !== attachment) return;
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (caught instanceof DOMException && caught.name === "NotAllowedError") state("blocked");
        else error();
      });
  };
  const scheduleRecovery = () => {
    if (!active || recoveryTimer !== undefined) return;
    recoveryTimer = setTimeout(
      () => {
        recoveryTimer = undefined;
        if (!active || !recovering) return;
        lastRecovery = Date.now();
        forceReload = true;
        void client.refresh(true).finally(() => {
          if (active && recovering) scheduleRecovery();
        });
      },
      Math.max(0, 5000 - (Date.now() - lastRecovery)),
    );
  };
  const error = () => {
    if (!active) return;
    recovering = true;
    state("error");
    scheduleRecovery();
  };
  const playing = () => {
    hasPlayed = true;
    shouldPlay = true;
    recovering = false;
    forceReload = false;
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    state("playing");
  };
  const waiting = () => {
    state("loading");
  };
  const paused = () => {
    if (hasPlayed && !recovering && !media.error) shouldPlay = false;
    state("paused");
  };
  media.addEventListener("playing", playing);
  media.addEventListener("waiting", waiting);
  media.addEventListener("pause", paused);
  media.addEventListener("error", error);
  const restore = () => {
    if (options.mode === "dvr" && resumeWallTime !== undefined && media.seekable.length) {
      const edge = media.seekable.end(media.seekable.length - 1),
        start = media.seekable.start(0);
      const target =
        previousWallEnd !== undefined
          ? edge - (previousWallEnd - resumeWallTime) / 1000
          : resumeTime;
      media.currentTime = Math.max(start, Math.min(edge - 0.1, target));
      resumeWallTime = undefined;
      resumeTime = 0;
    }
    if (resumeTime > 0 && Number.isFinite(media.duration)) {
      media.currentTime = Math.min(resumeTime, media.duration);
      resumeTime = 0;
    }
  };
  media.addEventListener("loadedmetadata", restore);
  const ready = () => {
    restore();
    play();
  };
  media.addEventListener("canplay", ready);
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
    if (url === currentUrl && !forceReload) {
      previousWallEnd = snapshot.playback?.wallEnd
        ? Date.parse(snapshot.playback.wallEnd)
        : undefined;
      if (!url) state(snapshot.error ? "error" : "unavailable");
      return;
    }
    // A failed initial attachment is paused too; preserve autoplay until media
    // has actually played, and while recovering from a failed engine.
    if (currentUrl && hasPlayed && !recovering) shouldPlay = !media.paused;
    const nextIdentity = `${String(snapshot.playback?.sourceSessionId)}:${String(snapshot.playback?.generation)}`;
    if (identity !== nextIdentity) resumeWallTime = undefined;
    if (
      options.mode === "dvr" &&
      identity === nextIdentity &&
      currentUrl &&
      media.seekable.length
    ) {
      const lag = media.seekable.end(media.seekable.length - 1) - media.currentTime;
      resumeWallTime =
        previousWallEnd !== undefined ? previousWallEnd - lag * 1000 : Date.now() - lag * 1000;
      resumeTime = media.currentTime;
    }
    previousWallEnd = snapshot.playback?.wallEnd
      ? Date.parse(snapshot.playback.wallEnd)
      : undefined;
    resumeTime =
      (options.mode === "vod" || options.mode === "dvr") && identity === nextIdentity && currentUrl
        ? media.currentTime
        : 0;
    identity = nextIdentity;
    currentUrl = url;
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    recovering = false;
    forceReload = false;
    hasPlayed = false;
    const attempt = ++attachment;
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
        detach = options.createHlsEngine(
          media,
          url,
          () => {
            if (active && attempt === attachment) error();
          },
          () => {
            if (active && attempt === attachment) {
              restore();
              play();
            }
          },
        );
      } catch {
        state("unsupported");
      }
    } else state("unsupported");
  };
  const unsubscribe = client.subscribe(update);
  update();
  return () => {
    active = false;
    attachment++;
    clearTimeout(recoveryTimer);
    unsubscribe();
    media.removeEventListener("playing", playing);
    media.removeEventListener("waiting", waiting);
    media.removeEventListener("pause", paused);
    media.removeEventListener("error", error);
    media.removeEventListener("canplay", ready);
    media.removeEventListener("loadedmetadata", restore);
    clear();
  };
}
