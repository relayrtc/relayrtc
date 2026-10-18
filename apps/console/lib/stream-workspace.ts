export const streamSections = [
  { id: "overview", label: "Overview" },
  { id: "broadcasts", label: "Broadcasts" },
  { id: "destinations", label: "Destinations" },
  { id: "guests", label: "Guests" },
  { id: "dvr", label: "Viewer rewind" },
  { id: "recordings", label: "Recordings" },
  { id: "clips", label: "Clips" },
  { id: "schedule", label: "Schedule" },
  { id: "studio", label: "Mixer studio" },
  { id: "settings", label: "Settings" },
] as const;
export type StreamSection = (typeof streamSections)[number]["id"];
export function streamWorkspaceHref(
  base: string,
  streamId: string,
  environmentId: string,
  section = "overview",
  broadcastId?: string | null,
) {
  const query = new URLSearchParams({ environmentId });
  if (broadcastId) query.set("broadcastId", broadcastId);
  return `${base}/streams/${encodeURIComponent(streamId)}${section === "overview" ? "" : `/${section}`}?${query}`;
}
