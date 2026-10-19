import { MediaCaptureError, normalizeMediaError } from "./errors.js";
import type { BrowserMediaEnvironment } from "./environment.js";

export interface ScreenShareSnapshot {
  readonly active: boolean;
  readonly audioTrack: MediaStreamTrack | null;
  readonly videoTrack: MediaStreamTrack | null;
}

export type ScreenShareListener = (snapshot: ScreenShareSnapshot) => void;

export class ScreenShareController {
  readonly #environment: BrowserMediaEnvironment;
  readonly #listeners = new Set<ScreenShareListener>();
  #audioTrack: MediaStreamTrack | null = null;
  #videoTrack: MediaStreamTrack | null = null;
  #revision = 0;

  constructor(environment: BrowserMediaEnvironment) {
    this.#environment = environment;
  }

  get current(): ScreenShareSnapshot {
    return {
      active: this.#videoTrack !== null,
      audioTrack: this.#audioTrack,
      videoTrack: this.#videoTrack,
    };
  }

  async start(options: DisplayMediaStreamOptions = { video: true }): Promise<ScreenShareSnapshot> {
    this.stop();
    const revision = this.#revision;
    try {
      const stream = await this.#environment.mediaDevices.getDisplayMedia(options);
      if (revision !== this.#revision) {
        for (const track of stream.getTracks()) track.stop();
        throw new MediaCaptureError(
          "MEDIA_CAPTURE_ABORTED",
          "The screen capture request was cancelled",
        );
      }
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack || videoTrack.readyState === "ended") {
        for (const track of stream.getTracks()) track.stop();
        throw new MediaCaptureError(
          "MEDIA_DEVICE_NOT_FOUND",
          "The selected display did not provide a video track",
        );
      }
      const audioTrack = stream.getAudioTracks().find((track) => track.readyState !== "ended");
      for (const extra of stream.getTracks())
        if (extra !== videoTrack && extra !== audioTrack) extra.stop();
      this.#videoTrack = videoTrack;
      this.#audioTrack = audioTrack ?? null;
      videoTrack.addEventListener("ended", this.#handleEnded, { once: true });
      audioTrack?.addEventListener("ended", this.#handleAudioEnded, { once: true });
      this.#emit();
      return this.current;
    } catch (error) {
      throw normalizeMediaError(error);
    }
  }

  stop(): void {
    this.#revision++;
    const videoTrack = this.#videoTrack;
    const audioTrack = this.#audioTrack;
    this.#videoTrack = null;
    this.#audioTrack = null;
    videoTrack?.removeEventListener("ended", this.#handleEnded);
    audioTrack?.removeEventListener("ended", this.#handleAudioEnded);
    videoTrack?.stop();
    audioTrack?.stop();
    if (videoTrack || audioTrack) this.#emit();
  }

  subscribe(listener: ScreenShareListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  readonly #handleEnded = (): void => {
    this.stop();
  };
  readonly #handleAudioEnded = (): void => {
    this.#audioTrack = null;
    this.#emit();
  };

  #emit(): void {
    const snapshot = this.current;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
