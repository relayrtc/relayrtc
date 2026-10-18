import type { GuestResource, GuestRoster, GuestMedia, GuestJoinGrant } from "@relayrtc/types";
import { RelayClient } from "./relay-client.js";
import type { Room, RelayClientOptions } from "./room.js";
export type StreamGuestCommand =
  | "invite"
  | "requestJoin"
  | "acceptInvite"
  | "declineInvite"
  | "cancelInvite"
  | "approveRequest"
  | "rejectRequest"
  | "mute"
  | "remove"
  | "leave";
export interface StreamGuestOptions {
  getStatus: (signal: AbortSignal) => Promise<GuestRoster>;
  command: (
    action: StreamGuestCommand,
    input: {
      guestId?: string;
      version?: number;
      recipientSubject?: string;
      media?: GuestMedia;
      audio?: boolean;
      video?: boolean;
    },
    context: { signal: AbortSignal; idempotencyKey: string },
  ) => Promise<GuestResource>;
  getJoinGrant?: (guestId: string, version: number, signal: AbortSignal) => Promise<GuestJoinGrant>;
  rtcOptions?: Omit<RelayClientOptions, "signalingUrl" | "refreshToken">;
  pollIntervalMs?: number;
}
export interface StreamGuestSnapshot {
  roster: GuestRoster | null;
  room: Room | null;
  activeGuestId: string | null;
  pending: StreamGuestCommand | "joinStage" | null;
  error: Error | null;
}
const initial: StreamGuestSnapshot = {
  roster: null,
  room: null,
  activeGuestId: null,
  pending: null,
  error: null,
};
/** Application-backed audience/host operations. Joining never enables devices automatically. */
export class StreamGuestClient {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private revision = 0;
  private guestVersion = 0;
  private roomListener: (() => void) | undefined;
  private keys = new Map<string, string>();
  private readonly interval: number;
  constructor(private options: StreamGuestOptions) {
    this.interval = options.pollIntervalMs ?? 2000;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60000)
      throw new Error("Invalid guest polling interval");
  }
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(next: StreamGuestSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  connect() {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.refresh();
  }
  disconnect() {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    this.revision++;
    this.roomListener?.();
    this.roomListener = undefined;
    void this.snapshot.room?.leave().catch(() => undefined);
    this.emit(initial);
  }
  dispose() {
    this.disconnect();
    this.listeners.clear();
    this.keys.clear();
  }
  private isCurrent(controller: AbortController) {
    return controller === this.controller && !controller.signal.aborted;
  }
  refresh = async () => {
    const controller = this.controller;
    if (!controller || this.polling) return;
    this.polling = true;
    const revision = this.revision;
    try {
      const roster = await this.options.getStatus(
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (controller !== this.controller || controller.signal.aborted || revision !== this.revision)
        return;
      const guest = roster.data.find((g) => g.id === this.snapshot.activeGuestId);
      if (
        this.snapshot.room &&
        (!roster.stage.enabled ||
          !guest ||
          !["accepted", "approved", "joined"].includes(guest.state) ||
          guest.version !== this.guestVersion ||
          Date.parse(guest.expiresAt) <= Date.now())
      )
        await this.leaveStage();
      if (this.isCurrent(controller)) this.emit({ ...this.snapshot, roster, error: null });
    } catch {
      if (controller === this.controller && !controller.signal.aborted)
        this.emit({
          ...this.snapshot,
          error: new Error("Guest status is unavailable. Check your access or try again."),
        });
    } finally {
      this.polling = false;
      if (controller === this.controller && !controller.signal.aborted) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.refresh();
        }, this.interval);
      } else if (this.controller) void this.refresh();
    }
  };
  command = async (
    action: StreamGuestCommand,
    input: Parameters<StreamGuestOptions["command"]>[1],
  ): Promise<GuestResource | null> => {
    const controller = this.controller;
    if (!controller || this.snapshot.pending) return null;
    const revision = ++this.revision,
      key = `${action}:${JSON.stringify(input)}`,
      idempotencyKey = this.keys.get(key) ?? crypto.randomUUID();
    this.keys.set(key, idempotencyKey);
    this.emit({ ...this.snapshot, pending: action, error: null });
    try {
      const result = await this.options.command(action, input, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        idempotencyKey,
      });
      if (controller !== this.controller || controller.signal.aborted || revision !== this.revision)
        return null;
      this.keys.delete(key);
      this.emit({ ...this.snapshot, pending: null });
      await this.refresh();
      return result;
    } catch {
      if (controller === this.controller && !controller.signal.aborted)
        this.emit({
          ...this.snapshot,
          pending: null,
          error: new Error("Guest action failed. Refresh its state before retrying."),
        });
      return null;
    }
  };
  joinStage = async (guestId: string): Promise<Room | null> => {
    const controller = this.controller,
      guest = this.snapshot.roster?.data.find((g) => g.id === guestId);
    if (
      !controller ||
      this.snapshot.pending ||
      this.snapshot.room ||
      !guest ||
      !this.options.getJoinGrant
    )
      return null;
    const revision = ++this.revision,
      getGrant = this.options.getJoinGrant,
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    this.emit({ ...this.snapshot, pending: "joinStage", error: null });
    let room: Room | undefined;
    try {
      const grant = await getGrant(guestId, guest.version, signal);
      const rtc = new RelayClient({
        ...this.options.rtcOptions,
        signalingUrl: grant.signalingUrl,
        refreshToken: async (context) => {
          const next = await getGrant(guestId, grant.version, context.signal);
          if (next.participantId !== grant.participantId || next.version !== grant.version)
            throw new Error("Guest grant changed; rejoin with consent.");
          return next.token;
        },
      });
      room = await rtc.join(grant.token, { signal });
      if (
        controller !== this.controller ||
        controller.signal.aborted ||
        revision !== this.revision
      ) {
        await room.leave();
        return null;
      }
      this.guestVersion = grant.version;
      this.roomListener = room.on("connectionStateChanged", (state) => {
        if (state === "disconnected" || state === "failed") {
          this.roomListener?.();
          this.roomListener = undefined;
          void room?.leave().catch(() => undefined);
          this.emit({
            ...this.snapshot,
            room: null,
            activeGuestId: null,
            error: new Error("Stage disconnected. Refresh your invitation before joining again."),
          });
        }
      });
      this.emit({ ...this.snapshot, room, activeGuestId: guestId, pending: null, error: null });
      return room;
    } catch {
      await room?.leave().catch(() => undefined);
      if (controller === this.controller && !controller.signal.aborted)
        this.emit({
          ...this.snapshot,
          pending: null,
          error: new Error(
            "Could not join the stage. Check your invitation and media permissions.",
          ),
        });
      return null;
    }
  };
  leaveStage = async () => {
    const room = this.snapshot.room;
    this.roomListener?.();
    this.roomListener = undefined;
    this.emit({ ...this.snapshot, room: null, activeGuestId: null });
    await room?.leave();
  };
}
