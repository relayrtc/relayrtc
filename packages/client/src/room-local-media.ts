import { normalizeMediaError } from "./errors.js";
import type { LocalMediaTrackController } from "./local-media-track.js";
import { MediaManager } from "./media-manager.js";
import { RoomError } from "./room-errors.js";
import type { LocalPublication, RoomRtc } from "./room-rtc.js";
import type {
  RoomInputControl,
  RoomInputSnapshot,
  RoomLocalMedia,
  RoomScreenControl,
  RoomScreenSnapshot,
} from "./room-media.js";
import type { ScreenShareController } from "./screen-share.js";
import type { MediaSourceKind } from "./types.js";

interface MediaContext {
  readonly rtc: RoomRtc;
  manager(): MediaManager;
  assertActive(): void;
  report(error: RoomError): void;
}

function mediaFailure(error: unknown): RoomError {
  if (error instanceof RoomError) return error;
  const failure = normalizeMediaError(error);
  return new RoomError(failure.code, failure.message);
}

function assertLiveTrack(track: MediaStreamTrack): void {
  if (track.readyState === "ended")
    throw new RoomError("MEDIA_CAPTURE_ABORTED", "The captured media track has ended");
}

abstract class MediaControl<Snapshot> {
  protected revision = 0;
  protected closed = false;
  protected busy = false;
  protected cleanup: Promise<void> | undefined;
  readonly #listeners = new Set<(snapshot: Snapshot) => void>();

  constructor(protected readonly context: MediaContext) {}
  abstract get current(): Snapshot;

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    if (!this.closed) this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  protected emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.current);
      } catch {
        continue;
      }
    }
  }

  protected destroy(): void {
    this.closed = true;
    this.revision++;
    this.emit();
    this.#listeners.clear();
  }

  protected validate(revision = this.revision): void {
    if (this.closed || revision !== this.revision)
      throw new RoomError("MEDIA_OPERATION_CANCELLED", "The local media operation was cancelled");
    this.context.assertActive();
  }

  protected async execute<Value>(operation: (revision: number) => Promise<Value>): Promise<Value> {
    this.validate();
    if (this.busy || this.cleanup)
      throw new RoomError(
        "MEDIA_OPERATION_PENDING",
        "Wait for the current local media operation to finish",
      );
    this.busy = true;
    this.emit();
    try {
      return await operation(this.revision);
    } catch (error) {
      throw this.report(error);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  protected control(operation: () => void): void {
    try {
      this.validate();
      if (this.busy || this.cleanup)
        throw new RoomError(
          "MEDIA_OPERATION_PENDING",
          "Wait for the current local media operation to finish",
        );
      operation();
      this.emit();
    } catch (error) {
      throw this.report(error);
    }
  }

  protected remove(publications: readonly (LocalPublication | undefined)[]): Promise<void> {
    this.cleanup = Promise.allSettled(
      publications.map((publication) => publication?.close() ?? Promise.resolve()),
    )
      .then((results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw this.report(failed.reason);
      })
      .finally(() => {
        this.cleanup = undefined;
        this.emit();
      });
    this.emit();
    return this.cleanup;
  }

  protected report(error: unknown): RoomError {
    const failure = mediaFailure(error);
    if (!this.closed && failure.code !== "MEDIA_OPERATION_CANCELLED") this.context.report(failure);
    return failure;
  }
}

class RoomInput extends MediaControl<RoomInputSnapshot> implements RoomInputControl {
  #capture: LocalMediaTrackController | undefined;
  #publication: LocalPublication | undefined;
  #detachEnded: (() => void) | undefined;

  constructor(
    readonly source: MediaSourceKind,
    context: MediaContext,
  ) {
    super(context);
  }

  get current(): RoomInputSnapshot {
    const capture = this.#capture?.current;
    return {
      source: this.source,
      enabled: !!this.#publication,
      pending: this.busy || !!this.cleanup,
      muted: this.#publication?.muted ?? false,
      deviceId: capture?.deviceId ?? null,
      track: capture?.track ?? null,
      publication: this.#publication?.info ?? null,
    };
  }

  enable(constraints: MediaTrackConstraints = {}): Promise<MediaStreamTrack> {
    return this.execute(async (revision) => {
      const capture = this.#controller();
      if (this.#publication && capture.current.track) return capture.current.track;
      let publication: LocalPublication | undefined;
      try {
        const track = await capture.enable(constraints);
        this.validate(revision);
        assertLiveTrack(track);
        publication = await this.context.rtc.publish(
          track,
          this.source === "microphone" ? "audio" : "camera_video",
        );
        this.validate(revision);
        assertLiveTrack(track);
        this.#publication = publication;
        this.#watch(track);
        this.emit();
        return track;
      } catch (error) {
        capture.disable();
        await publication?.close().catch(() => undefined);
        this.emit();
        throw error;
      }
    });
  }

  disable(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.revision++;
    const publication = this.#publication;
    this.#publication = undefined;
    this.#detachEnded?.();
    this.#detachEnded = undefined;
    publication?.dispose();
    this.#capture?.disable();
    this.emit();
    return this.remove([publication]);
  }

  switchDevice(deviceId: string): Promise<MediaStreamTrack | null> {
    return this.execute(async (revision) => {
      const capture = this.#controller();
      const previous = capture.current.track;
      const publication = this.#publication;
      try {
        const track = await capture.switchDevice(deviceId);
        this.validate(revision);
        if (track && publication) {
          assertLiveTrack(track);
          await publication.replaceTrack(track);
          this.validate(revision);
          assertLiveTrack(track);
          this.#watch(track);
        }
        this.emit();
        return track;
      } catch (error) {
        if (capture.current.track !== previous) await this.disable().catch(() => undefined);
        throw error;
      }
    });
  }

  mute(): void {
    this.control(() => {
      this.#requirePublication().mute();
    });
  }
  unmute(): void {
    this.control(() => {
      this.#requirePublication().unmute();
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.#detachEnded?.();
    this.#detachEnded = undefined;
    this.#publication?.dispose();
    this.#publication = undefined;
    this.#capture?.disable();
    this.destroy();
  }

  #controller(): LocalMediaTrackController {
    this.#capture ??= this.context.manager()[this.source];
    return this.#capture;
  }

  #requirePublication(): LocalPublication {
    if (!this.#publication)
      throw new RoomError(
        "MEDIA_NOT_ENABLED",
        `Enable the ${this.source} before changing mute state`,
      );
    return this.#publication;
  }

  #watch(track: MediaStreamTrack): void {
    this.#detachEnded?.();
    const ended = (): void => {
      void this.disable().catch(() => undefined);
    };
    track.addEventListener("ended", ended, { once: true });
    this.#detachEnded = () => {
      track.removeEventListener("ended", ended);
    };
  }
}

class RoomScreen extends MediaControl<RoomScreenSnapshot> implements RoomScreenControl {
  #capture: ScreenShareController | undefined;
  #video: LocalPublication | undefined;
  #audio: LocalPublication | undefined;
  #unsubscribe: (() => void) | undefined;
  #detachAudio: (() => void) | undefined;
  #stoppingCapture = false;

  get current(): RoomScreenSnapshot {
    const capture = this.#capture?.current;
    return {
      active: !!this.#video && !!capture?.active,
      pending: this.busy || !!this.cleanup,
      videoTrack: capture?.videoTrack ?? null,
      audioTrack: capture?.audioTrack ?? null,
      muted: this.#video?.muted ?? false,
      videoPublication: this.#video?.info ?? null,
      audioPublication: this.#audio?.info ?? null,
    };
  }

  start(options: DisplayMediaStreamOptions = { video: true }): Promise<RoomScreenSnapshot> {
    return this.execute(async (revision) => {
      if (this.current.active) return this.current;
      const capture = this.#controller();
      let video: LocalPublication | undefined;
      let audio: LocalPublication | undefined;
      try {
        const screen = await capture.start(options);
        this.validate(revision);
        if (!screen.videoTrack || screen.videoTrack.readyState === "ended")
          throw new RoomError("MEDIA_CAPTURE_ABORTED", "The selected screen has stopped");
        if (screen.audioTrack) {
          const audioTrack = screen.audioTrack;
          const ended = (): void => {
            void this.stop().catch(() => undefined);
          };
          audioTrack.addEventListener("ended", ended, { once: true });
          this.#detachAudio = () => {
            audioTrack.removeEventListener("ended", ended);
          };
        }
        video = await this.context.rtc.publish(screen.videoTrack, "screen_video");
        this.validate(revision);
        if (screen.audioTrack) {
          if (screen.audioTrack.readyState === "ended")
            throw new RoomError("MEDIA_CAPTURE_ABORTED", "The selected screen audio has stopped");
          audio = await this.context.rtc.publish(screen.audioTrack, "screen_audio");
          this.validate(revision);
        }
        assertLiveTrack(screen.videoTrack);
        if (screen.audioTrack) assertLiveTrack(screen.audioTrack);
        this.#video = video;
        this.#audio = audio;
        this.emit();
        return this.current;
      } catch (error) {
        this.#stopCapture();
        await Promise.allSettled(
          [video, audio].map((publication) => publication?.close() ?? Promise.resolve()),
        );
        this.emit();
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.revision++;
    const publications = [this.#video, this.#audio];
    this.#video = undefined;
    this.#audio = undefined;
    for (const publication of publications) publication?.dispose();
    this.#stopCapture();
    this.emit();
    return this.remove(publications);
  }

  mute(): void {
    this.control(() => {
      this.#requireVideo().mute();
      this.#audio?.mute();
    });
  }
  unmute(): void {
    this.control(() => {
      this.#requireVideo().unmute();
      this.#audio?.unmute();
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#video?.dispose();
    this.#audio?.dispose();
    this.#video = undefined;
    this.#audio = undefined;
    this.#stopCapture();
    this.destroy();
  }

  #controller(): ScreenShareController {
    if (!this.#capture) {
      this.#capture = this.context.manager().screen;
      this.#unsubscribe = this.#capture.subscribe((snapshot) => {
        if (!snapshot.active && !this.#stoppingCapture && !this.closed)
          void this.stop().catch(() => undefined);
      });
    }
    return this.#capture;
  }

  #stopCapture(): void {
    this.#detachAudio?.();
    this.#detachAudio = undefined;
    this.#stoppingCapture = true;
    try {
      this.#capture?.stop();
    } finally {
      this.#stoppingCapture = false;
    }
  }

  #requireVideo(): LocalPublication {
    if (!this.#video)
      throw new RoomError("MEDIA_NOT_ENABLED", "Start screen sharing before changing mute state");
    return this.#video;
  }
}

export class LocalRoomMedia implements RoomLocalMedia {
  readonly microphone: RoomInput;
  readonly camera: RoomInput;
  readonly screen: RoomScreen;
  readonly devices: RoomLocalMedia["devices"];
  readonly permissions: RoomLocalMedia["permissions"];
  #manager: MediaManager | undefined;
  #closed = false;
  readonly #deviceSubscriptions = new Set<() => void>();

  constructor(rtc: RoomRtc, assertActive: () => void, report: (error: RoomError) => void) {
    const manager = (): MediaManager => {
      assertActive();
      if (this.#closed) throw new RoomError("NOT_CONNECTED", "The room media controls are closed");
      this.#manager ??= new MediaManager();
      return this.#manager;
    };
    const context: MediaContext = { rtc, manager, assertActive, report };
    this.microphone = new RoomInput("microphone", context);
    this.camera = new RoomInput("camera", context);
    this.screen = new RoomScreen(context);
    this.devices = {
      enumerate: async () => {
        try {
          const snapshot = await manager().devices.enumerate();
          assertActive();
          return snapshot;
        } catch (error) {
          throw mediaFailure(error);
        }
      },
      subscribe: (listener) => {
        const stop = manager().devices.subscribe((snapshot) => {
          if (!this.#closed) listener(snapshot);
        });
        const unsubscribe = (): void => {
          stop();
          this.#deviceSubscriptions.delete(unsubscribe);
        };
        this.#deviceSubscriptions.add(unsubscribe);
        return unsubscribe;
      },
    };
    this.permissions = {
      get: async () => {
        try {
          const snapshot = await manager().permissions.get();
          assertActive();
          return snapshot;
        } catch (error) {
          throw mediaFailure(error);
        }
      },
      request: async (request) => {
        try {
          const snapshot = await manager().permissions.request(request);
          assertActive();
          return snapshot;
        } catch (error) {
          const failure = mediaFailure(error);
          if (!this.#closed) report(failure);
          throw failure;
        }
      },
    };
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.microphone.dispose();
    this.camera.dispose();
    this.screen.dispose();
    for (const unsubscribe of this.#deviceSubscriptions) unsubscribe();
    this.#deviceSubscriptions.clear();
    this.#manager?.dispose();
  }
}
