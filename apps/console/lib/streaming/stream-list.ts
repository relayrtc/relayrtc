import type { ConsoleBroadcast } from "./broadcast-contracts";
import type { ConsoleSchedule } from "./schedule-contracts";

export type StreamListActivity = {
  category: "live" | "scheduled" | "ended" | "ready";
  label: string;
  timestamp: string | null;
};

export function streamListActivity(
  streamId: string,
  broadcasts: ConsoleBroadcast[],
  schedules: ConsoleSchedule[],
): StreamListActivity {
  const history = broadcasts
    .filter((broadcast) => broadcast.streamId === streamId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const active = history.find((broadcast) =>
    ["waiting_for_source", "starting", "live", "reconnecting", "degraded", "stopping"].includes(
      broadcast.state,
    ),
  );
  if (active) {
    const labels = {
      waiting_for_source: "Waiting for source",
      starting: "Starting",
      live: "Live",
      reconnecting: "Reconnecting",
      degraded: "Degraded",
      stopping: "Stopping",
    };
    return {
      category: "live",
      label: labels[active.state as keyof typeof labels],
      timestamp: active.startedAt ?? active.startRequestedAt,
    };
  }
  const scheduled = schedules
    .filter((schedule) => schedule.streamId === streamId && schedule.state === "scheduled")
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  if (scheduled)
    return { category: "scheduled", label: "Scheduled", timestamp: scheduled.startsAt };
  const latest = history[0];
  if (latest && ["stopped", "failed"].includes(latest.state)) {
    return {
      category: "ended",
      label: latest.state === "failed" ? "Failed" : "Ended",
      timestamp: latest.endedAt,
    };
  }
  return { category: "ready", label: latest ? "Draft" : "Ready", timestamp: null };
}
