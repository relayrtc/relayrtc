import type { RoomEvents } from "./room.js";

export class RoomEventEmitter {
  readonly #listeners: {
    [Event in keyof RoomEvents]: Set<(value: RoomEvents[Event]) => void>;
  } = {
    activityChanged:new Set(),
    lifecycleChanged: new Set(),
    capabilitiesChanged: new Set(),
    connectionQualityChanged: new Set(),
    connectionDegraded: new Set(),
    connectionRecovered: new Set(),
    qualityStatsUpdated: new Set(),
    connectionStateChanged: new Set(),
    error: new Set(),
    messageReceived: new Set(),
    messageSent: new Set(),
    customEventReceived: new Set(),
    customEventSent: new Set(),
    localParticipantUpdated: new Set(),
    presenceChanged: new Set(),
    credentialsRefreshed: new Set(),
    reconnectAttempt: new Set(),
    reconnected: new Set(),
    participantJoined: new Set(),
    participantLeft: new Set(),
    participantUpdated: new Set(),
    participantReconnected: new Set(),
    trackPublished: new Set(),
    trackUnpublished: new Set(),
    trackUpdated: new Set(),
    trackSubscribed: new Set(),
    trackUnsubscribed: new Set(),
    trackSubscriptionFailed: new Set(),
  };

  on<Event extends keyof RoomEvents>(
    event: Event,
    listener: (value: RoomEvents[Event]) => void,
  ): () => void {
    this.#listeners[event].add(listener);
    return () => {
      this.#listeners[event].delete(listener);
    };
  }

  emit<Event extends keyof RoomEvents>(event: Event, value: RoomEvents[Event]): void {
    for (const listener of [...this.#listeners[event]]) {
      try {
        listener(value);
      } catch {
        continue;
      }
    }
  }

  clear(): void {
    for (const listeners of Object.values(this.#listeners)) listeners.clear();
  }
}
