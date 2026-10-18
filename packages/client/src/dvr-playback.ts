export interface DvrPlaybackState {
  start: number;
  end: number;
  position: number;
  behindLiveSeconds: number;
  isLive: boolean;
  paused: boolean;
  available: boolean;
  recoveredExpiredSeek: boolean;
}
const initial: DvrPlaybackState = {
  start: 0,
  end: 0,
  position: 0,
  behindLiveSeconds: 0,
  isLive: true,
  paused: true,
  available: false,
  recoveredExpiredSeek: false,
};
/** Uses the browser's actual seekable ranges; it never assumes advertised media is buffered. */
export class DvrPlaybackController {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private media: HTMLVideoElement,
    private onExpired?: () => void,
  ) {}
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish = (recovered = this.snapshot.recoveredExpiredSeek) => {
    const m = this.media,
      ranges = m.seekable;
    const available = ranges.length > 0;
    const start = available ? ranges.start(0) : 0,
      end = available ? ranges.end(ranges.length - 1) : 0;
    const lag = available ? Math.max(0, end - m.currentTime) : 0;
    this.snapshot = {
      start,
      end,
      position: m.currentTime,
      behindLiveSeconds: lag,
      isLive: lag <= 4,
      paused: m.paused,
      available,
      recoveredExpiredSeek: recovered,
    };
    for (const listener of this.listeners) listener();
  };
  private update = () => {
    const m = this.media;
    if (m.seekable.length && m.currentTime > 0 && m.currentTime < m.seekable.start(0) - 0.5) {
      m.currentTime = m.seekable.start(0) + 0.1;
      this.publish(true);
      this.onExpired?.();
    } else this.publish();
  };
  seek = (seconds: number) => {
    if (!Number.isFinite(seconds) || !this.media.seekable.length) return;
    const ranges = this.media.seekable,
      start = ranges.start(0),
      end = ranges.end(ranges.length - 1);
    let target = Math.max(start + 0.1, Math.min(end - 0.1, seconds));
    let valid = false;
    for (let i = 0; i < ranges.length; i++)
      if (target >= ranges.start(i) && target <= ranges.end(i)) {
        valid = true;
        break;
      }
    if (!valid) target = end - 0.1;
    this.media.currentTime = target;
    const recovered = seconds < start || seconds > end || !valid;
    this.publish(recovered);
    if (recovered) this.onExpired?.();
  };
  rewind = (seconds = 30) => {
    if (seconds > 0) this.seek(this.media.currentTime - seconds);
  };
  goLive = () => {
    if (this.media.seekable.length)
      this.seek(
        Math.max(
          this.media.seekable.start(0) + 0.1,
          this.media.seekable.end(this.media.seekable.length - 1) - 1.5,
        ),
      );
  };
  start() {
    if (this.timer) return;
    for (const event of [
      "timeupdate",
      "progress",
      "durationchange",
      "seeking",
      "play",
      "pause",
      "loadedmetadata",
    ])
      this.media.addEventListener(event, this.update);
    this.timer = setInterval(this.update, 1000);
    this.update();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const event of [
      "timeupdate",
      "progress",
      "durationchange",
      "seeking",
      "play",
      "pause",
      "loadedmetadata",
    ])
      this.media.removeEventListener(event, this.update);
  }
}
export const initialDvrPlaybackState = initial;
