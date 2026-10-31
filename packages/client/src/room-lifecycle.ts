import type { RoomLifecycle, UpdateRoomLifecycle } from "@relayrtc/types";

export interface RoomLifecycleControl {
  readonly current: RoomLifecycle | null;
  get(): Promise<RoomLifecycle>;
  update(input: UpdateRoomLifecycle): Promise<RoomLifecycle>;
}

export type {
  RoomLifecycle,
  UpdateRoomLifecycle,
  RoomInvitation,
  CreateRoomInvitation,
  RedeemRoomInvitation,
} from "@relayrtc/types";
