import { EventEmitter } from "node:events";
import type { Consumer, Producer, Router } from "mediasoup/types";
import { expect, it, vi } from "vitest";
import { DynamicStreamingExports } from "./dynamic-streaming-export.js";

it("exports the highest camera layer and retries keyframes without a renewal storm", async () => {
  const consumer = {
    kind: "video",
    closed: false,
    paused: true,
    rtpParameters: { codecs: [{ mimeType: "video/VP8", payloadType: 96, clockRate: 90000 }] },
    setPreferredLayers: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn(() => {
      consumer.paused = false;
      return Promise.resolve();
    }),
    requestKeyFrame: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue([]),
  };
  const transport = {
    connect: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn(() => Promise.resolve(consumer as unknown as Consumer)),
    close: vi.fn(),
  };
  const router = {
    observer: new EventEmitter(),
    rtpCapabilities: { codecs: [] },
    createPlainTransport: vi.fn(() => Promise.resolve(transport)),
  } as unknown as Router;
  const producer = {
    id: "camera",
    kind: "video",
    type: "simulcast",
    paused: false,
    closed: false,
    appData: { participantId: "host", trackType: "camera" },
    rtpParameters: { codecs: consumer.rtpParameters.codecs, encodings: [{}, {}, {}] },
  } as unknown as Producer;
  const exports = new DynamicStreamingExports();
  try {
    await exports.create(
      {
        exportId: "export",
        roomId: "room",
        receiverIp: "127.0.0.1",
        ports: [50000],
        videoTrackIds: [],
        audioTrackIds: [],
        audioOnly: false,
        layout: "single",
      },
      router,
      new Map([[producer.id, producer]]),
    );
    expect(consumer.setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 2 });
    await exports.control("export", "resume");
    await exports.control("export", "renew");
    await exports.control("export", "resume");
    expect(consumer.requestKeyFrame).toHaveBeenCalledTimes(1);
  } finally {
    exports.closeAll();
  }
});
