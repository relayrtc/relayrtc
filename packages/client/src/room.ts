import type { RoomAccessControl, RoomCapabilities } from "./room-access.js";
import type {RoomActivityControl,RoomActivitySnapshot,ParticipantActivityPreferences} from "./room-activity.js";
import type { RoomLifecycleControl,RoomLifecycle } from "./room-lifecycle.js";
import type { ParticipantSession, Room as RoomInfo } from "@relayrtc/types";
import type { RoomError } from "./room-errors.js";
import type { RoomLocalMedia, RoomLocalParticipant } from "./room-media.js";
import type { RoomRemoteParticipant, RoomRemoteTrack } from "./room-remote.js";
import type { RoomCredentialOptions, RoomCredentialSnapshot } from "./room-credentials.js";
import type {
  RoomCustomEvent,
  RoomCustomEvents,
  RoomMessages,
  RoomPresenceSnapshot,
  RoomTextMessage,
} from "./room-messaging-types.js";

export type RoomConnectionState =
  "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";

export interface RoomReconnectOptions {
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface MediaTransportStats {
  readonly direction: "send" | "receive";
  readonly state: RTCPeerConnectionState;
  readonly route: "direct" | "relay" | "unknown";
  readonly protocol: string | null;
  readonly relayProtocol: string | null;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

export interface MediaConnectionStats {
  readonly observedAt: string;
  readonly transports: readonly MediaTransportStats[];
}

export interface RoomEvents {
  readonly activityChanged:RoomActivitySnapshot;
  readonly lifecycleChanged: RoomLifecycle;
  readonly capabilitiesChanged: RoomCapabilities;
  readonly connectionQualityChanged: ConnectionQualityEvent;
  readonly connectionDegraded: ConnectionQualityEvent;
  readonly connectionRecovered: ConnectionQualityEvent;
  readonly qualityStatsUpdated: RtcQualityStats;
  readonly connectionStateChanged: RoomConnectionState;
  readonly error: RoomError;
  readonly messageReceived: RoomTextMessage;
  readonly messageSent: RoomTextMessage;
  readonly customEventReceived: RoomCustomEvent;
  readonly customEventSent: RoomCustomEvent;
  readonly localParticipantUpdated: RoomLocalParticipant;
  readonly presenceChanged: RoomPresenceSnapshot;
  readonly credentialsRefreshed: RoomCredentialSnapshot;
  readonly reconnectAttempt: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: RoomError;
  };
  readonly reconnected: { readonly attempts: number; readonly session: ParticipantSession };
  readonly participantJoined: RoomRemoteParticipant;
  readonly participantLeft: RoomRemoteParticipant;
  readonly participantUpdated: RoomRemoteParticipant;
  readonly participantReconnected: {
    readonly participant: RoomRemoteParticipant;
    readonly session: ParticipantSession;
  };
  readonly trackPublished: RoomRemoteTrack;
  readonly trackUnpublished: RoomRemoteTrack;
  readonly trackUpdated: RoomRemoteTrack;
  readonly trackSubscribed: RoomRemoteTrack;
  readonly trackUnsubscribed: RoomRemoteTrack;
  readonly trackSubscriptionFailed: { readonly track: RoomRemoteTrack; readonly error: RoomError };
}

export interface Room extends RoomLocalMedia {
  readonly activity:RoomActivityControl;
  readonly lifecycle: RoomLifecycleControl;
  readonly access: RoomAccessControl;
  readonly quality: ConnectionQuality | null;
  readonly qualityStats: RtcQualityStats | null;
  readonly participantQualities: ReadonlyMap<string, ConnectionQualityEvent>;
  readonly id: string;
  readonly info: RoomInfo;
  readonly localParticipant: RoomLocalParticipant;
  readonly session: ParticipantSession;
  readonly connectionState: RoomConnectionState;
  readonly participants: ReadonlyMap<string, RoomRemoteParticipant>;
  readonly remoteTracks: ReadonlyMap<string, RoomRemoteTrack>;
  readonly messages: RoomMessages;
  readonly events: RoomCustomEvents;
  readonly presence: RoomPresenceSnapshot;
  refreshCredentials(): Promise<void>;
  getMediaConnectionStats(): Promise<MediaConnectionStats>;
  on<Event extends keyof RoomEvents>(
    event: Event,
    listener: (value: RoomEvents[Event]) => void,
  ): () => void;
  leave(): Promise<void>;
}

export interface RelayClientOptions extends RoomCredentialOptions {
  readonly activity?:ParticipantActivityPreferences;
  readonly signalingUrl: string;
  readonly requestTimeoutMs?: number;
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  readonly autoSubscribe?: boolean;
  /** Default true. Broadcast stages may opt into one full-resolution video layer. */
  readonly videoSimulcast?: boolean;
  readonly reconnect?: false | RoomReconnectOptions;
}

export interface JoinOptions {
  readonly signal?: AbortSignal;
}
import type { ConnectionQuality, ConnectionQualityEvent } from "@relayrtc/types";
import type { RtcQualityStats } from "./quality.js";
