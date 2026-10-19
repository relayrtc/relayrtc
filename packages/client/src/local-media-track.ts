import { MediaCaptureError, normalizeMediaError } from "./errors.js";
import type { BrowserMediaEnvironment } from "./environment.js";
import type { LocalMediaTrackListener, LocalMediaTrackSnapshot, MediaSourceKind } from "./types.js";

export class LocalMediaTrackController {
  readonly #environment: BrowserMediaEnvironment;
  readonly #listeners = new Set<LocalMediaTrackListener>();
  readonly #source: MediaSourceKind;
  #constraints: MediaTrackConstraints = {};
  #deviceId: string | null = null;
  #track: MediaStreamTrack | null = null;
  #revision = 0;

  constructor(source: MediaSourceKind, environment: BrowserMediaEnvironment) {
    this.#source = source;
    this.#environment = environment;
  }

  get current(): LocalMediaTrackSnapshot {
    return {
      source: this.#source,
      deviceId: this.#deviceId,
      enabled: this.#track !== null,
      track: this.#track,
    };
  }

  async enable(constraints: MediaTrackConstraints = {}): Promise<MediaStreamTrack> {
    const revision = ++this.#revision;
    this.#constraints = constraints;
    const track = await this.#capture(this.#deviceId, constraints);
    this.#validateCapture(track, revision);
    this.#replace(track);
    return track;
  }

  disable(): void {
    this.#revision++;
    const current = this.#track;
    this.#track = null;
    current?.removeEventListener("ended", this.#handleEnded);
    current?.stop();
    this.#emit();
  }

  async switchDevice(deviceId: string): Promise<MediaStreamTrack | null> {
    if (!deviceId.trim()) {
      throw new MediaCaptureError("MEDIA_DEVICE_NOT_FOUND", "A media device ID is required");
    }
    if (!this.#track) {
      this.#revision++;
      this.#deviceId = deviceId;
      this.#emit();
      return null;
    }

    const revision = ++this.#revision;
    const track = await this.#capture(deviceId, this.#constraints);
    this.#validateCapture(track, revision);
    this.#deviceId = deviceId;
    this.#replace(track);
    return track;
  }

  subscribe(listener: LocalMediaTrackListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #replace(track: MediaStreamTrack): void {
    const previous = this.#track;
    previous?.removeEventListener("ended", this.#handleEnded);
    this.#track = track;
    track.addEventListener("ended", this.#handleEnded, { once: true });
    this.#deviceId = track.getSettings().deviceId ?? this.#deviceId;
    previous?.stop();
    this.#emit();
  }

  async #capture(
    deviceId: string | null,
    constraints: MediaTrackConstraints,
  ): Promise<MediaStreamTrack> {
    const requested = {
      ...constraints,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
    try {
      const stream = await this.#environment.mediaDevices.getUserMedia({
        audio: this.#source === "microphone" ? requested : false,
        video: this.#source === "camera" ? requested : false,
      });
      const [track] =
        this.#source === "microphone" ? stream.getAudioTracks() : stream.getVideoTracks();
      if (!track) {
        for (const streamTrack of stream.getTracks()) streamTrack.stop();
        throw new MediaCaptureError(
          "MEDIA_DEVICE_NOT_FOUND",
          `The requested ${this.#source} track is unavailable`,
        );
      }
      for (const extra of stream.getTracks()) if (extra !== track) extra.stop();
      return track;
    } catch (error) {
      throw normalizeMediaError(error);
    }
  }

  #validateCapture(track: MediaStreamTrack, revision: number): void {
    if (revision !== this.#revision || track.readyState === "ended") {
      track.stop();
      throw new MediaCaptureError(
        "MEDIA_CAPTURE_ABORTED",
        "The media capture request was cancelled",
      );
    }
  }

  readonly #handleEnded = (): void => {
    this.#track = null;
    this.#revision++;
    this.#emit();
  };

  #emit(): void {
    const snapshot = this.current;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
