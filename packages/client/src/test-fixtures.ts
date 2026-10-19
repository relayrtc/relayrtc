import { vi, type Mock } from "vitest";

import type { BrowserMediaEnvironment } from "./environment.js";

export type TestMediaTrack = Omit<MediaStreamTrack, "stop"> & {
  readonly stop: Mock<() => void>;
};

export const mediaTrack = (kind: "audio" | "video", deviceId: string) => {
  const events = new EventTarget();
  let readyState = "live";
  return {
    enabled: true,
    kind,
    getSettings: vi.fn(() => ({ deviceId })),
    get readyState() {
      return readyState;
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    stop: vi.fn(() => {
      readyState = "ended";
    }),
  } as unknown as TestMediaTrack;
};

export const mediaStream = (...tracks: MediaStreamTrack[]) =>
  ({
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks.filter((track) => track.kind === "audio")),
    getVideoTracks: vi.fn(() => tracks.filter((track) => track.kind === "video")),
  }) as unknown as MediaStream;

export const mediaDevice = (
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
): MediaDeviceInfo => ({
  deviceId,
  groupId: `group-${deviceId}`,
  kind,
  label,
  toJSON: () => ({}),
});

export const mediaEnvironment = (
  overrides: {
    readonly enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
    readonly getUserMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
    readonly getDisplayMedia?: (options?: DisplayMediaStreamOptions) => Promise<MediaStream>;
    readonly queryPermission?: (descriptor: PermissionDescriptor) => Promise<PermissionStatus>;
  } = {},
): BrowserMediaEnvironment => {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  const mediaDevices = {
    enumerateDevices: vi.fn(overrides.enumerateDevices ?? (() => Promise.resolve([]))),
    getUserMedia: vi.fn(overrides.getUserMedia ?? (() => Promise.resolve(mediaStream()))),
    getDisplayMedia: vi.fn(overrides.getDisplayMedia ?? (() => Promise.resolve(mediaStream()))),
    addEventListener: vi.fn((name: string, listener: EventListenerOrEventListenerObject) =>
      listeners.set(name, listener),
    ),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    dispatchEvent: vi.fn((event: Event) => {
      const listener = listeners.get(event.type);
      if (typeof listener === "function") listener(event);
      else listener?.handleEvent(event);
      return true;
    }),
  } as unknown as MediaDevices;
  const permissions = {
    query: vi.fn(
      overrides.queryPermission ?? (() => Promise.resolve({ state: "prompt" } as PermissionStatus)),
    ),
  } as unknown as Permissions;
  return { mediaDevices, permissions };
};
