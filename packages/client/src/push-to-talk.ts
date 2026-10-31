import type { Room } from "./room.js";

export interface PushToTalkSnapshot {
  readonly pressed: boolean;
  readonly active: boolean;
  readonly pending: boolean;
  readonly error: Error | null;
}
export interface PushToTalkController {
  readonly current: PushToTalkSnapshot;
  press(): Promise<void>;
  release(): Promise<void>;
  subscribe(listener: (snapshot: PushToTalkSnapshot) => void): () => void;
  dispose(): void;
}

export function createPushToTalk(room: Room): PushToTalkController {
  let desired = false;
  let active = false;
  let closed = false;
  let revision = 0;
  let error: Error | null = null;
  let pending: Promise<void> | undefined;
  const listeners = new Set<(snapshot: PushToTalkSnapshot) => void>();
  const snapshot = (): PushToTalkSnapshot =>
    Object.freeze({ pressed: desired, active, pending: !!pending, error });
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {
        continue;
      }
    }
  };
  const silence = () => {
    const track = room.microphone.current.track;
    if (track) track.enabled = false;
    active = false;
  };
  const held = () => desired && !closed;
  const drain = async () => {
    let observed = -1;
    while (observed !== revision) {
      observed = revision;
      if (desired && !closed) {
        if (room.connectionState !== "connected")
          throw new Error("Connect to a room before using push-to-talk");
        if (!room.access.current?.permissions.includes("audio:publish"))
          throw new Error("Microphone publication is not permitted");
        if (!room.microphone.current.enabled) await room.microphone.enable();
        if (!held()) {
          silence();
          continue;
        }
        await room.microphone.unmute();
        if (!held()) {
          silence();
          continue;
        }
        const track = room.microphone.current.track;
        if (track) track.enabled = true;
        active = true;
      } else {
        silence();
        if (room.microphone.current.enabled) {
          try {
            await room.microphone.mute();
          } catch {
            await room.microphone.disable();
          }
        } else if (room.microphone.current.pending) {
          await room.microphone.disable();
        }
      }
    }
  };
  const change = (pressed: boolean): Promise<void> => {
    if (closed && pressed) return Promise.reject(new Error("Push-to-talk controller is disposed"));
    desired = pressed;
    revision++;
    if (!pressed) {
      silence();
      if (room.microphone.current.pending && !room.microphone.current.enabled)
        void room.microphone.disable().catch(() => undefined);
    }
    if (pending) {
      emit();
      return pending;
    }
    error = null;
    pending = Promise.resolve()
      .then(drain)
      .catch((cause: unknown) => {
        desired = false;
        silence();
        error = cause instanceof Error ? cause : new Error("Push-to-talk failed");
        throw error;
      })
      .finally(() => {
        pending = undefined;
        emit();
      });
    emit();
    return pending;
  };
  const cleanup = [
    room.microphone.subscribe((value) => {
      if (!desired) {
        silence();
      } else if (!value.pending && !value.enabled) {
        void change(false).catch(() => undefined);
      }
      emit();
    }),
    room.on("connectionStateChanged", (state) => {
      if (state !== "connected") void change(false).catch(() => undefined);
    }),
    room.on("capabilitiesChanged", (capabilities) => {
      if (!capabilities.permissions.includes("audio:publish"))
        void change(false).catch(() => undefined);
    }),
  ];
  if (typeof window !== "undefined") {
    const release = () => {
      void change(false).catch(() => undefined);
    };
    const hidden = () => {
      if (document.hidden) release();
    };
    window.addEventListener("blur", release);
    window.addEventListener("pagehide", release);
    document.addEventListener("visibilitychange", hidden);
    cleanup.push(() => {
      window.removeEventListener("blur", release);
      window.removeEventListener("pagehide", release);
      document.removeEventListener("visibilitychange", hidden);
    });
  }
  void change(false).catch(() => undefined);
  return {
    get current() {
      return snapshot();
    },
    press: () => change(true),
    release: () => change(false),
    subscribe: (listener) => {
      if (!closed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (closed) return;
      closed = true;
      for (const dispose of cleanup) dispose();
      void change(false).catch(() => undefined);
      listeners.clear();
    },
  };
}
