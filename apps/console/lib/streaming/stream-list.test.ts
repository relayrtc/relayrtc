import { describe, expect, it } from "vitest";
import { streamListActivity } from "./stream-list";
import type { ConsoleBroadcast } from "./broadcast-contracts";
import type { ConsoleSchedule } from "./schedule-contracts";

function broadcast(state: ConsoleBroadcast["state"], createdAt = "2026-10-18T12:00:00Z") {
  return {
    streamId: "stream-a",
    state,
    createdAt,
    startedAt: "2026-10-18T12:01:00Z",
    endedAt: "2026-10-18T13:00:00Z",
  } as ConsoleBroadcast;
}
function schedule(startsAt: string) {
  return { streamId: "stream-a", state: "scheduled", startsAt } as ConsoleSchedule;
}

describe("stream list activity", () => {
  it("keeps a running broadcast visible even when a newer draft exists", () => {
    expect(
      streamListActivity(
        "stream-a",
        [broadcast("live"), broadcast("created", "2026-10-18T14:00:00Z")],
        [schedule("2026-10-19T12:00:00Z")],
      ),
    ).toMatchObject({ category: "live", label: "Live" });
  });
  it("shows the earliest pending schedule ahead of an ended broadcast", () => {
    expect(
      streamListActivity(
        "stream-a",
        [broadcast("stopped")],
        [schedule("2026-10-20T12:00:00Z"), schedule("2026-10-19T12:00:00Z")],
      ),
    ).toEqual({ category: "scheduled", label: "Scheduled", timestamp: "2026-10-19T12:00:00Z" });
  });
  it("does not mark a new draft as ended because of an older failure", () => {
    expect(
      streamListActivity(
        "stream-a",
        [broadcast("failed"), broadcast("created", "2026-10-18T14:00:00Z")],
        [],
      ),
    ).toEqual({ category: "ready", label: "Draft", timestamp: null });
  });
  it("ignores activity belonging to another stream", () => {
    expect(
      streamListActivity("stream-b", [broadcast("live")], [schedule("2026-10-19T12:00:00Z")]),
    ).toEqual({ category: "ready", label: "Ready", timestamp: null });
  });
  it("preserves failure and reconnecting states rather than claiming the stream is live", () => {
    expect(streamListActivity("stream-a", [broadcast("failed")], []).label).toBe("Failed");
    expect(streamListActivity("stream-a", [broadcast("reconnecting")], []).label).toBe(
      "Reconnecting",
    );
  });
});
