import type { Metadata, Participant, Track } from "@relayrtc/types";
import type {
  MediaDeviceListener,
  MediaDeviceSnapshot,
  MediaPermissionRequest,
  MediaPermissionsSnapshot,
  MediaSourceKind,
} from "./types.js";
import type { ScreenShareSnapshot } from "./screen-share.js";

export type RoomLocalTrackType = Exclude<Track["type"], "data">;

export interface RoomInputSnapshot {
  readonly source: MediaSourceKind;
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly muted: boolean;
  readonly deviceId: string | null;
  readonly track: MediaStreamTrack | null;
  readonly publication: Track | null;
}

export interface RoomInputControl {
  readonly current: RoomInputSnapshot;
  enable(constraints?: MediaTrackConstraints): Promise<MediaStreamTrack>;
  disable(): Promise<void>;
  switchDevice(deviceId: string): Promise<MediaStreamTrack | null>;
  mute(): void;
  unmute(): void;
  subscribe(listener: (snapshot: RoomInputSnapshot) => void): () => void;
}

export interface RoomScreenSnapshot extends ScreenShareSnapshot {
  readonly pending: boolean;
  readonly muted: boolean;
  readonly videoPublication: Track | null;
  readonly audioPublication: Track | null;
}

export interface RoomScreenControl {
  readonly current: RoomScreenSnapshot;
  start(options?: DisplayMediaStreamOptions): Promise<RoomScreenSnapshot>;
  stop(): Promise<void>;
  mute(): void;
  unmute(): void;
  subscribe(listener: (snapshot: RoomScreenSnapshot) => void): () => void;
}

export interface RoomMediaDevices {
  enumerate(): Promise<MediaDeviceSnapshot>;
  subscribe(listener: MediaDeviceListener): () => void;
}

export interface RoomMediaPermissions {
  get(): Promise<MediaPermissionsSnapshot>;
  request(request?: MediaPermissionRequest): Promise<MediaPermissionsSnapshot>;
}

export interface RoomLocalMedia {
  readonly microphone: RoomInputControl;
  readonly camera: RoomInputControl;
  readonly screen: RoomScreenControl;
  readonly devices: RoomMediaDevices;
  readonly permissions: RoomMediaPermissions;
}

export interface RoomLocalParticipant extends Participant, RoomLocalMedia {
  updateMetadata(metadata: Metadata): Promise<Participant>;
}
