import type { RoomActivitySnapshot, ParticipantActivityPreferences } from "@relayrtc/types";
import type { RoomConnectionState } from "./room.js";
import { RoomError } from "./room-errors.js";

export interface RoomActivityControl {
  readonly current: RoomActivitySnapshot | null;
  readonly preferences: ParticipantActivityPreferences;
  get(): Promise<RoomActivitySnapshot>;
  configure(preferences: ParticipantActivityPreferences): Promise<ParticipantActivityPreferences>;
}

export class LocalRoomActivity implements RoomActivityControl {
  #current: RoomActivitySnapshot | null = null;
  #preferences: ParticipantActivityPreferences;
  #connected = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #cleanup: (() => void)[] = [];
  #lastInput = Date.now();
  #sentInput = 0;
  #receivedAt = 0;
  #lastSent = 0;
  #pending: Promise<ParticipantActivityPreferences> | undefined;
  #configuring = false;
  #epoch = 0;
  #cancelWait: (() => void) | undefined;
  constructor(
    readonly read: () => Promise<RoomActivitySnapshot>,
    readonly send: (
      preferences: ParticipantActivityPreferences,
      visible: boolean,
      active: boolean,
    ) => Promise<ParticipantActivityPreferences>,
    readonly changed: (snapshot: RoomActivitySnapshot) => void,
    initial: ParticipantActivityPreferences = {
      mode: "auto",
      shareActivity: true,
      shareSpeaking: true,
    },
  ) {
    this.#preferences = Object.freeze({ ...initial });
  }
  get current() {
    return this.#current;
  }
  get preferences() {
    return this.#preferences;
  }
  async get() {
    const snapshot = await this.read();
    this.apply(snapshot);
    return snapshot;
  }
  async configure(preferences: ParticipantActivityPreferences) {
    if (!this.#connected)
      throw new RoomError("NOT_CONNECTED", "Join the room before changing activity preferences");
    if (this.#configuring) throw new Error("An activity preference update is already pending");
    this.#configuring = true;
    const epoch = this.#epoch;
    try {
      if (this.#pending) await this.#pending;
      const wait = Math.max(0, 1100 - (Date.now() - this.#lastSent));
      if (wait)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.#cancelWait = undefined;
            resolve();
          }, wait);
          this.#cancelWait = () => {
            clearTimeout(timer);
            reject(new RoomError("NOT_CONNECTED", "The activity update was cancelled"));
          };
        });
      if (!this.#sameConnection(epoch))
        throw new RoomError(
          "NOT_CONNECTED",
          "The room disconnected before saving activity preferences",
        );
      const result = await this.#update(preferences);
      if (!this.#sameConnection(epoch))
        throw new RoomError(
          "NOT_CONNECTED",
          "The room disconnected while saving activity preferences",
        );
      this.#preferences = Object.freeze({ ...result });
      return result;
    } finally {
      this.#configuring = false;
    }
  }
  apply(snapshot: RoomActivitySnapshot) {
    if (!this.#connected) return;
    this.#receivedAt = Date.now();
    this.#current = Object.freeze({
      ...snapshot,
      policy: Object.freeze({ ...snapshot.policy }),
      participants: Object.freeze(snapshot.participants.map((item) => Object.freeze({ ...item }))),
      speakers: Object.freeze(snapshot.speakers.map((item) => Object.freeze({ ...item }))),
    });
    this.changed(this.#current);
  }
  connection(state: RoomConnectionState) {
    this.#stop();
    this.#connected = state === "connected";
    if (!this.#connected) {
      this.#uncertain();
      return;
    }
    const documentValue = typeof document === "undefined" ? undefined : document;
    if (documentValue) {
      const active = () => {
        if (!documentValue.hidden) this.#lastInput = Date.now();
      };
      for (const event of ["pointerdown", "pointermove", "keydown", "wheel"]) {
        documentValue.addEventListener(event, active, { passive: true });
        this.#cleanup.push(() => {
          documentValue.removeEventListener(event, active);
        });
      }
    }
    const heartbeat = () => {
      if (!this.#pending && !this.#configuring && Date.now() - this.#lastSent >= 1100)
        void this.#update(this.#preferences).catch(() => undefined);
    };
    heartbeat();
    this.#timer = setInterval(heartbeat, 15_000);
    this.#watchdog = setInterval(() => {
      if (Date.now() - this.#receivedAt > 6000) this.#uncertain();
    }, 1000);
  }
  dispose() {
    this.#connected = false;
    this.#stop();
    this.#current = null;
  }
  #update(preferences: ParticipantActivityPreferences) {
    this.#lastSent = Date.now();
    const input = this.#lastInput;
    this.#pending = this.send(
      preferences,
      typeof document === "undefined" || !document.hidden,
      preferences.shareActivity && input > this.#sentInput,
    )
      .then((result) => {
        this.#sentInput = input;
        return result;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }
  #uncertain() {
    if (!this.#current) return;
    const current = this.#current;
    if (
      current.speakerState !== "available" &&
      current.participants.every((item) => item.state === "unknown" || item.state === "hidden")
    )
      return;
    this.#current = Object.freeze({
      ...current,
      speakers: [],
      dominantSpeakerId: null,
      speakerState: current.speakerState === "disabled" ? "disabled" : "unavailable",
      participants: current.participants.map((item) => ({
        ...item,
        state: item.state === "hidden" ? ("hidden" as const) : ("unknown" as const),
      })),
    });
    this.changed(this.#current);
  }
  #stop() {
    this.#epoch++;
    this.#cancelWait?.();
    this.#cancelWait = undefined;
    clearInterval(this.#timer);
    clearInterval(this.#watchdog);
    this.#timer = undefined;
    this.#watchdog = undefined;
    for (const cleanup of this.#cleanup) cleanup();
    this.#cleanup = [];
  }
  #sameConnection(epoch: number) {
    return this.#connected && epoch === this.#epoch;
  }
}

export type {
  RoomActivityPolicy,
  RoomActivitySnapshot,
  ParticipantActivityPreferences,
  ParticipantActivityState,
} from "@relayrtc/types";
