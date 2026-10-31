export const participantActivityStates = [
  "online",
  "away",
  "inactive",
  "unknown",
  "hidden",
] as const;
export type ParticipantActivityState = (typeof participantActivityStates)[number];

export interface RoomActivityPolicy {
  readonly version: number;
  readonly activityEnabled: boolean;
  readonly speakersEnabled: boolean;
  readonly idleSeconds: number;
  readonly heartbeatSeconds: number;
}

export interface ParticipantActivityPreferences {
  readonly mode: "auto" | "away";
  readonly shareActivity: boolean;
  readonly shareSpeaking: boolean;
}

export interface RoomActivitySnapshot {
  readonly roomId: string;
  readonly observedAt: string;
  readonly policy: RoomActivityPolicy;
  readonly participants: readonly {
    readonly participantId: string;
    readonly state: ParticipantActivityState;
  }[];
  readonly truncated: boolean;
  readonly speakers: readonly { readonly participantId: string; readonly level: number }[];
  readonly dominantSpeakerId: string | null;
  readonly speakerState: "available" | "unavailable" | "disabled";
}
