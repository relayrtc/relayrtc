import { describe, expect, it } from "vitest";

import type { SubscriberNetworkStats } from "../engine/quality-controller.js";
import {
  classifyConnectionQuality,
  intervalNetworkStats,
  qualityTransitionEvent,
} from "./quality-model.js";

const stats = (overrides: Partial<SubscriberNetworkStats> = {}): SubscriberNetworkStats => ({
  availableIncomingBitrate: 4_000_000,
  jitter: 0.01,
  packetsLost: 1,
  packetsReceived: 999,
  roundTripTime: 0.05,
  timestamp: 1,
  ...overrides,
});

describe("connection quality model", () => {
  it("classifies excellent, good, poor, critical, and lost connections", () => {
    expect(classifyConnectionQuality(stats())).toBe("excellent");
    expect(classifyConnectionQuality(stats({ availableIncomingBitrate: 2_000_000 }))).toBe("good");
    expect(classifyConnectionQuality(stats({ availableIncomingBitrate: 400_000 }))).toBe("poor");
    expect(classifyConnectionQuality(stats({ availableIncomingBitrate: 70_000 }))).toBe("critical");
    expect(
      classifyConnectionQuality(
        stats({ availableIncomingBitrate: 0, packetsLost: 0, packetsReceived: 0 }),
      ),
    ).toBe("lost");
  });

  it("emits only healthy boundary transitions", () => {
    expect(qualityTransitionEvent("good", "poor")).toBe("connection.degraded");
    expect(qualityTransitionEvent("critical", "good")).toBe("connection.recovered");
    expect(qualityTransitionEvent("poor", "critical")).toBeNull();
    expect(qualityTransitionEvent(undefined, "excellent")).toBeNull();
  });

  it("turns cumulative WebRTC packet counters into interval deltas", () => {
    expect(
      intervalNetworkStats(
        stats({ timestamp: 2, packetsLost: 5, packetsReceived: 195 }),
        stats({ packetsLost: 2, packetsReceived: 98 }),
      ),
    ).toEqual(expect.objectContaining({ packetsLost: 3, packetsReceived: 97 }));
  });
});
