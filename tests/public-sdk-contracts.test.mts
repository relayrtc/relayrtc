import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  RelayServer,
  recordingEventTypes as nodeRecordingEvents,
  scheduleEventTypes as nodeScheduleEvents,
  webhookEventTypes as nodeWebhookEvents,
} from "../../node-sdk/src/index.js";
import type {
  StreamPlayback,
  ServiceUsageMetric as NodeServiceUsageMetric,
  StreamingOperation as NodeOperation,
  UsageCategory,
} from "../../node-sdk/src/index.js";
import {
  StreamPlaybackClient,
  type StreamPlaybackMetadata,
  type StreamPlaybackOptions,
} from "../packages/client/src/stream-playback.js";
import {
  recordingEventTypes,
  scheduleEventTypes,
  webhookEventTypes,
  type ServiceUsageMetric,
  type StreamingOperation,
} from "../packages/types/src/index.js";
import {
  ingestCredentialSchema,
  playbackGrantSchema,
  streamPlaybackReadinessSchema,
} from "../packages/validation/src/streaming.js";
import { webhookEventTypeSchema } from "../packages/validation/src/webhook.js";
import type { PublicUsageCategory } from "../packages/validation/src/public-usage.js";
import { listRoomsQuerySchema } from "../services/api/src/modules/rooms/room.schema.js";

function server(fetch: typeof globalThis.fetch) {
  return new RelayServer({
    apiUrl: "https://api.example.test/v1",
    apiKey: `rk_sk_test_${"a".repeat(43)}`,
    fetch,
    retry: false,
  });
}

afterEach(() => vi.useRealTimers());

describe("public SDK and API contracts", () => {
  it("sends encoder credential bodies accepted by the real ingest validator", async () => {
    const received: unknown[] = [];
    const sdk = server(async (url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      received.push(ingestCredentialSchema.parse(body));
      return Response.json(
        {
          id: "ingest_test",
          expiresAt: "2026-10-25T15:00:00Z",
          secret: "encoder-only",
          protocol: "whip",
          url: "https://api.example.test/v1/ingest/whip/stream_test",
          ...(String(url).endsWith("/rotate")
            ? {
                handover: {
                  policy: "disconnect-and-reconnect",
                  status: "ready",
                  retryAfterSeconds: 0,
                },
              }
            : {}),
        },
        { status: 201 },
      );
    });
    await sdk.streams.createIngestCredentials("stream_test", { ttlSeconds: 600 });
    await sdk.streams.rotateIngestCredentials("stream_test", "ingest_old");
    expect(received).toEqual([{ ttlSeconds: 600 }, { ttlSeconds: 3600 }]);
    expect(
      ingestCredentialSchema.safeParse({ mode: "dvr", broadcastId: "broadcast_test" }).success,
    ).toBe(false);
  });

  it("keeps DVR mode and broadcast selection on viewer grants", async () => {
    const sdk = server(async (_url, init) => {
      const input: unknown = JSON.parse(String(init?.body));
      expect(playbackGrantSchema.parse(input)).toEqual({
        ttlSeconds: 300,
        mode: "dvr",
        broadcastId: "broadcast_test",
      });
      return Response.json({
        token: "viewer-only",
        url: "https://api.example.test/dvr/index.m3u8",
        expiresAt: "2026-10-25T15:00:00Z",
      });
    });
    await sdk.streams.createPlaybackGrant("stream_test", {
      mode: "dvr",
      broadcastId: "broadcast_test",
    });
  });

  it.each([true, false])(
    "serializes joinable=%s into the API room query format",
    async (joinable) => {
      const sdk = server(async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("joinable")).toBe(String(joinable));
        expect(listRoomsQuerySchema.parse(Object.fromEntries(url.searchParams))).toMatchObject({
          search: "Team room",
          joinable,
          limit: 50,
        });
        return Response.json({ nodes: [], pageInfo: { endCursor: null, hasNextPage: false } });
      });
      await sdk.rooms.list({ search: "Team room", joinable });
    },
  );

  it("keeps SDK webhook and event-family literals synchronized with the domain validators", () => {
    expect([...nodeWebhookEvents].sort()).toEqual([...webhookEventTypes].sort());
    expect(new Set(nodeWebhookEvents).size).toBe(nodeWebhookEvents.length);
    for (const event of nodeWebhookEvents) expect(webhookEventTypeSchema.parse(event)).toBe(event);
    expect([...nodeRecordingEvents].sort()).toEqual([...recordingEventTypes].sort());
    expect([...nodeScheduleEvents].sort()).toEqual([...scheduleEventTypes].sort());
  });

  it("accepts Node playback results as browser callbacks without dropping delivery readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T14:00:00Z"));
    const readiness = streamPlaybackReadinessSchema.parse({
      status: "degraded",
      publisherConnected: true,
      sourceProducing: true,
      outputStarting: true,
      viewerReady: false,
      code: "PLAYBACK_NOT_READY",
      checkedAt: "2026-10-25T14:00:00Z",
    });
    const playback: StreamPlayback = {
      streamId: "stream_test",
      sourceSessionId: "session_test",
      generation: 1,
      state: "reconnecting",
      sourceState: "live",
      readiness,
      profile: {
        audioOnly: false,
        width: 1280,
        height: 720,
        fps: 30,
        videoBitrate: 2500000,
        audioBitrate: 128000,
        layout: "single",
      },
      protocols: ["hls", "ll-hls"],
      grantRequired: true,
      grantTtlSeconds: 300,
      renewal: "POST /v1/streams/{streamId}/playback-grants",
      delivery: "single-rendition-fmp4",
      latencyTargetSeconds: null,
    };
    let viewerGrants = 0;
    const sdk = server(async (input) => {
      if (new URL(String(input)).pathname.endsWith("/playback")) return Response.json(playback);
      viewerGrants++;
      return Response.json({
        token: "viewer-only",
        url: "https://api.example.test/playback.m3u8",
        expiresAt: "2026-10-25T14:05:00Z",
      });
    });
    const options: StreamPlaybackOptions = {
      getPlayback: (signal) => sdk.streams.getPlayback("stream_test", { signal }),
      getGrant: (signal) => sdk.streams.createPlaybackGrant("stream_test", {}, { signal }),
    };
    const client = new StreamPlaybackClient(options);
    try {
      client.start();
      await client.refresh();
      const metadata: StreamPlaybackMetadata | null = client.getSnapshot().playback;
      expect(metadata?.sourceState).toBe("live");
      expect(metadata?.readiness).toEqual(readiness);
      expect(viewerGrants).toBe(0);
      expect(client.getSnapshot().error).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it("keeps usage categories and operation responses compatible across package boundaries", () => {
    expectTypeOf<UsageCategory>().toEqualTypeOf<PublicUsageCategory>();
    expectTypeOf<NodeServiceUsageMetric>().toEqualTypeOf<ServiceUsageMetric>();
    expectTypeOf<NodeOperation>().toEqualTypeOf<StreamingOperation>();
    const operation: StreamingOperation = {
      id: "sop_test",
      streamId: "stream_test",
      sessionId: null,
      kind: "stop",
      status: "pending",
      errorCode: null,
      createdAt: "2026-10-25T14:00:00Z",
      completedAt: null,
    };
    expect(operation.sessionId).toBeNull();
  });
});
