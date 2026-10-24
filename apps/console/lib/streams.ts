import type { StreamInput, StreamType } from "./stream-types";
export type { Stream, StreamInput, StreamType, Recording, Clip } from "./stream-types";

export const streamTypes: { value: StreamType; label: string }[] = [{ value: "whip", label: "WHIP" }, { value: "rtmp", label: "RTMP" }, { value: "room", label: "Room" }];
export const defaultProfile = { audioOnly: false, width: 1280, height: 720, fps: 30, videoBitrate: 2500000, audioBitrate: 128000, layout: "single" as const };
export const dvrWindows = [1, 5, 15, 30];
export const streamOverviewPath = (id: string) => `/streams/${encodeURIComponent(id)}/overview`;
export const streamTypeLabel = (type: StreamType) => type === "room" ? "Room" : type.toUpperCase();
export const streamStatusLabel = (state: string) => state.replaceAll("_", " ").replace(/^./, value => value.toUpperCase());
export function validateStream(input: StreamInput): string | null {
  if (!input.name.trim() || input.name.trim().length > 120) return "Enter a stream name with up to 120 characters.";
  if (input.source.kind === "room" && !input.source.roomId) return "Choose an available room.";
  return null;
}
export function formatTimecode(value: number) {
  const seconds = Math.max(0, Math.floor(value || 0));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return [hours, minutes, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
}
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
export function formatBitrate(bits: number) { return bits > 0 ? `${(bits / 1000000).toFixed(2)} Mbps` : "—"; }
