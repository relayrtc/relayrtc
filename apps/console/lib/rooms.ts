import type { RoomSession, RoomStatus } from "./room-types";
export type { Room } from "./room-types";

export const maxRoomCapacity = 100000;
export const maxRoomNameLength = 120;
export const roomOverviewPath = (id: string) => `/rooms/${encodeURIComponent(id)}/overview`;

export function validateRoom(name: string, capacity: number) {
  if (!name.trim()) return "Give your room a name.";
  if (name.trim().length > maxRoomNameLength) return "Room names can be up to 120 characters.";
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > maxRoomCapacity)
    return "Maximum participants must be a whole number from 1 to 100,000.";
  return null;
}

export function connectionDuration(session: RoomSession, observedAt: string, now: number) {
  const elapsed = session.live && now ? Math.max(0, now - Date.parse(observedAt)) : 0;
  return Math.max(0, session.connectionSeconds * 1000 + elapsed);
}

export function formatDuration(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = total % 60, minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function sessionStateName(session: RoomSession) {
  if (session.removedAt) return "Removed";
  if (session.live) return "Connected";
  if (session.leftAt || session.state === "connected") return "Disconnected";
  return session.state.charAt(0).toUpperCase() + session.state.slice(1);
}

export function roomStatusName(status: RoomStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Casablanca", day: "2-digit", month: "short", year: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Casablanca", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export function formatConnectionTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { date: "—", time: "—" };
  return { date: dateFormatter.format(date), time: timeFormatter.format(date) };
}
export function formatRoomTime(value: string) {
  const { date, time } = formatConnectionTime(value);
  return `${date}, ${time}`;
}
