import { RoomError } from "./room-errors.js";
import { RoomEventEmitter } from "./room-events.js";
import { RoomSession } from "./room-session.js";
import { readParticipantToken } from "./participant-token.js";
import { recoveryOptions } from "./room-recovery.js";
import type {
  JoinOptions,
  RelayClientOptions,
  Room,
  RoomConnectionState,
  RoomEvents,
} from "./room.js";

export class RelayClient {
  readonly #options: RelayClientOptions;
  readonly #events = new RoomEventEmitter();
  #room: RoomSession | undefined;
  #state: RoomConnectionState = "disconnected";

  constructor(options: RelayClientOptions) {
    this.#events.on("connectionStateChanged", (state) => {
      this.#state = state;
    });
    try {
      const url = new URL(options.signalingUrl);
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      const timeout = options.requestTimeoutMs ?? 10_000;
      recoveryOptions(options.reconnect);
      const margin = options.credentialRefreshMarginMs ?? 60_000;
      if (!Number.isInteger(margin) || margin < 1000 || margin > 300_000) throw new Error();
      if (options.refreshToken !== undefined && typeof options.refreshToken !== "function")
        throw new Error();
      if (
        options.refreshTurnCredentials !== undefined &&
        typeof options.refreshTurnCredentials !== "function"
      )
        throw new Error();
      if (options.autoSubscribe !== undefined && typeof options.autoSubscribe !== "boolean")
        throw new Error();
      if (options.videoSimulcast !== undefined && typeof options.videoSimulcast !== "boolean")
        throw new Error();
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error();
      if (options.iceTransportPolicy && !["all", "relay"].includes(options.iceTransportPolicy))
        throw new Error();
      this.#options = {
        ...options,
        ...(options.reconnect ? { reconnect: { ...options.reconnect } } : {}),
        signalingUrl: url.href,
        ...(options.iceServers ? { iceServers: structuredClone(options.iceServers) } : {}),
        ...(options.turnCredentials
          ? { turnCredentials: structuredClone(options.turnCredentials) }
          : {}),
      };
    } catch {
      throw new RoomError(
        "INVALID_CONFIGURATION",
        "Provide a ws/wss URL without credentials, query or fragment, a timeout from 1 to 60000 ms, a refresh margin from 1000 to 300000 ms, and callable refresh providers",
      );
    }
  }

  get currentRoom(): Room | undefined {
    return this.#room;
  }
  get connectionState(): RoomConnectionState {
    return this.#room?.connectionState ?? this.#state;
  }

  on<Event extends keyof RoomEvents>(
    event: Event,
    listener: (value: RoomEvents[Event]) => void,
  ): () => void {
    return this.#events.on(event, listener);
  }

  async join(token: string, options: JoinOptions = {}): Promise<Room> {
    if (this.#room)
      throw new RoomError("ALREADY_JOINED", "Leave the current room before joining another room");
    const scope = readParticipantToken(token);
    const room = new RoomSession(this.#options, this.#events, () => {
      if (this.#room === room) this.#room = undefined;
    });
    this.#room = room;
    await room.start(token, scope, options);
    return room;
  }

  async leave(): Promise<void> {
    await this.#room?.leave();
  }
}
