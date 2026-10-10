import { describe, expect, it } from "vitest";

import { normalizeRtcStats, simulcastEncodings } from "./quality.js";

describe("RTC auto quality", () => {
  it("defines low-to-high simulcast encodings", () => {
    expect(simulcastEncodings.map((encoding) => encoding.rid)).toEqual(["q", "h", "f"]);
    expect(simulcastEncodings.map((encoding) => encoding.scaleResolutionDownBy)).toEqual([
      3, 1.5, 1,
    ]);
  });

  it("normalizes transport and RTP stats", () => {
    const timestamp = Date.now();
    const entries = new Map<string, Record<string, unknown>>([
      [
        "pair",
        {
          id: "pair",
          type: "candidate-pair",
          selected: true,
          state: "succeeded",
          timestamp,
          availableIncomingBitrate: 2_000_000,
          availableOutgoingBitrate: 1_000_000,
          currentRoundTripTime: 0.1,
        },
      ],
      [
        "in",
        {
          id: "in",
          type: "inbound-rtp",
          timestamp,
          bytesReceived: 500,
          packetsLost: 2,
          packetsReceived: 98,
          jitter: 0.02,
        },
      ],
      ["out", { id: "out", type: "outbound-rtp", timestamp, bytesSent: 300 }],
    ]);

    expect(normalizeRtcStats(entries as unknown as RTCStatsReport)).toEqual(
      expect.objectContaining({
        availableIncomingBitrate: 2_000_000,
        availableOutgoingBitrate: 1_000_000,
        bytesReceived: 500,
        bytesSent: 300,
        jitter: 0.02,
        packetsLost: 2,
        packetsReceived: 98,
        roundTripTime: 0.1,
      }),
    );
  });

  it("excludes the bandwidth probing stream from media loss and jitter", () => {
    const timestamp = Date.now();
    const report = new Map<string, Record<string, unknown>>([
      ["media", { id: "media", type: "inbound-rtp", timestamp, trackIdentifier: "camera", bytesReceived: 500, packetsReceived: 98, packetsLost: 2, jitter: 0.01 }],
      ["probe", { id: "probe", type: "inbound-rtp", timestamp, trackIdentifier: "probator", bytesReceived: 1000, packetsReceived: 8, packetsLost: 80, jitter: 0.5 }],
    ]);
    expect(normalizeRtcStats(report as unknown as RTCStatsReport)).toEqual(expect.objectContaining({
      bytesReceived: 500,
      packetsReceived: 98,
      packetsLost: 2,
      jitter: 0.01,
    }));
  });
});
