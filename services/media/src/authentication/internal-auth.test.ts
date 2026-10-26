import {
  createMediaControlToken,
  type MediaControlAuthority,
  type MediaControlClaims,
} from "@relayrtc/protocol/media-control";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { readMediaEnvironment } from "../config/environment.js";
import type { MediaEngine } from "../engine/media-engine.js";
import { MediaEngineError } from "../engine/errors.js";

const secret = "test-media-control-secret-at-least-32-characters";
const config = {
  ...readMediaEnvironment({ RELAYRTC_INTERNAL_SECRET: secret }),
  logLevel: "silent" as const,
};
const room = { kind: "room", roomId: "room_1" } as const;
const participant = {
  kind: "participant",
  roomId: "room_1",
  participantId: "participant_1",
  sessionId: "session_1",
} as const;

const createEngine = () =>
  ({
    close: vi.fn<MediaEngine["close"]>().mockResolvedValue(undefined),
    start: vi.fn<MediaEngine["start"]>().mockResolvedValue(undefined),
    flushUsage: vi.fn<MediaEngine["flushUsage"]>().mockResolvedValue(undefined),
    createRoom: vi.fn<MediaEngine["createRoom"]>().mockResolvedValue(undefined),
    closeRoom: vi.fn<MediaEngine["closeRoom"]>().mockResolvedValue(undefined),
    getCapacity: vi.fn<MediaEngine["getCapacity"]>().mockReturnValue({
      maxRooms: 10,
      maxTransportsPerRoom: 20,
      rooms: 1,
      transports: 2,
      workers: 1,
    }),
    getHealth: vi.fn<MediaEngine["getHealth"]>().mockResolvedValue({
      capacity: { maxRooms: 10, maxTransportsPerRoom: 20, rooms: 1, transports: 2, workers: 1 },
      healthy: true,
      workersAlive: 1,
    }),
    getRouterCapabilities: vi.fn<MediaEngine["getRouterCapabilities"]>().mockResolvedValue({}),
    listPublishedTracks: vi.fn<MediaEngine["listPublishedTracks"]>().mockResolvedValue([]),
    createParticipantTransport: vi
      .fn<MediaEngine["createParticipantTransport"]>()
      .mockResolvedValue({
        id: "transport_1",
        direction: "send",
        dtlsParameters: {},
        iceCandidates: [],
        iceParameters: {},
      }),
    connectParticipantTransport: vi
      .fn<MediaEngine["connectParticipantTransport"]>()
      .mockResolvedValue(undefined),
    restartParticipantTransport: vi
      .fn<MediaEngine["restartParticipantTransport"]>()
      .mockResolvedValue({}),
    publishTrack: vi.fn<MediaEngine["publishTrack"]>().mockResolvedValue({
      id: "track_1",
      kind: "audio",
      participantId: "participant_1",
      trackType: "audio",
      priority: "normal",
    }),
    subscribeTrack: vi.fn<MediaEngine["subscribeTrack"]>().mockResolvedValue({
      id: "subscription_1",
      kind: "audio",
      producerId: "track_1",
      rtpParameters: {},
      trackId: "track_1",
      trackType: "audio",
      priority: "normal",
      quality: null,
    }),
    ingestSubscriberStats: vi
      .fn<MediaEngine["ingestSubscriberStats"]>()
      .mockResolvedValue(undefined),
    resumeSubscription: vi.fn<MediaEngine["resumeSubscription"]>().mockResolvedValue(undefined),
    setSubscriptionQuality: vi
      .fn<MediaEngine["setSubscriptionQuality"]>()
      .mockResolvedValue(undefined),
    setParticipantPriority: vi
      .fn<MediaEngine["setParticipantPriority"]>()
      .mockResolvedValue(undefined),
    setParticipantQualityMode: vi
      .fn<MediaEngine["setParticipantQualityMode"]>()
      .mockResolvedValue(undefined),
    setTrackPriority: vi.fn<MediaEngine["setTrackPriority"]>().mockResolvedValue(undefined),
    removeTrack: vi.fn<MediaEngine["removeTrack"]>().mockResolvedValue(undefined),
    controlTrack: vi.fn<MediaEngine["controlTrack"]>().mockResolvedValue(undefined),
    removeParticipant: vi.fn<MediaEngine["removeParticipant"]>().mockResolvedValue(undefined),
  }) satisfies MediaEngine;

interface RouteCase {
  method: MediaControlClaims["method"];
  path: string;
  authority: MediaControlAuthority;
  body?: Record<string, unknown>;
  status: number;
}

const routes: RouteCase[] = [
  { method: "GET", path: "/capacity", authority: { kind: "capacity" }, status: 200 },
  { method: "POST", path: "/rooms/room_1", authority: room, status: 201 },
  { method: "DELETE", path: "/rooms/room_1", authority: room, status: 204 },
  { method: "GET", path: "/rooms/room_1/capabilities", authority: participant, status: 200 },
  { method: "GET", path: "/rooms/room_1/tracks", authority: participant, status: 200 },
  {
    method: "POST",
    path: "/rooms/room_1/transports",
    authority: participant,
    body: { participantId: "participant_1", direction: "send" },
    status: 201,
  },
  {
    method: "PATCH",
    path: "/rooms/room_1/transports/transport_1",
    authority: participant,
    body: { participantId: "participant_1", dtlsParameters: {} },
    status: 204,
  },
  {
    method: "POST",
    path: "/rooms/room_1/transports/transport_1/restart-ice",
    authority: participant,
    body: { participantId: "participant_1" },
    status: 200,
  },
  {
    method: "POST",
    path: "/rooms/room_1/tracks",
    authority: participant,
    body: {
      participantId: "participant_1",
      transportId: "transport_1",
      kind: "audio",
      trackType: "audio",
      rtpParameters: {},
    },
    status: 201,
  },
  {
    method: "POST",
    path: "/rooms/room_1/subscriptions",
    authority: participant,
    body: {
      participantId: "participant_1",
      transportId: "transport_1",
      trackId: "track_1",
      rtpCapabilities: {},
    },
    status: 201,
  },
  {
    method: "POST",
    path: "/rooms/room_1/stats",
    authority: participant,
    body: {
      participantId: "participant_1",
      stats: {
        availableIncomingBitrate: null,
        jitter: null,
        packetsLost: 0,
        packetsReceived: 0,
        roundTripTime: null,
        timestamp: 1000,
      },
    },
    status: 202,
  },
  {
    method: "PATCH",
    path: "/rooms/room_1/subscriptions/subscription_1/resume",
    authority: participant,
    body: { participantId: "participant_1" },
    status: 204,
  },
  {
    method: "PATCH",
    path: "/rooms/room_1/subscriptions/subscription_1/quality",
    authority: participant,
    body: { participantId: "participant_1", quality: "auto" },
    status: 204,
  },
  {
    method: "PATCH",
    path: "/rooms/room_1/participants/participant_1/priority",
    authority: participant,
    body: { priority: "high" },
    status: 204,
  },
  {
    method: "PATCH",
    path: "/rooms/room_1/participants/participant_1/quality-mode",
    authority: participant,
    body: { mode: "balanced" },
    status: 204,
  },
  {
    method: "PATCH",
    path: "/rooms/room_1/participants/participant_1/tracks/track_1/priority",
    authority: participant,
    body: { priority: "high" },
    status: 204,
  },
  {
    method: "DELETE",
    path: "/rooms/room_1/participants/participant_1/tracks/track_1",
    authority: participant,
    status: 204,
  },
  ...(["pause", "resume"] as const).map((action) => ({
    method: "PATCH" as const,
    path: `/rooms/room_1/participants/participant_1/tracks/track_1/${action}`,
    authority: participant,
    status: 204,
  })),
  {
    method: "DELETE",
    path: "/rooms/room_1/participants/participant_1",
    authority: { kind: "participant-cleanup", roomId: "room_1", participantId: "participant_1" },
    status: 204,
  },
];

const tokenFor = (route: RouteCase, authority = route.authority, tokenSecret = secret): string =>
  createMediaControlToken(tokenSecret, {
    service: "relayrtc-signaling",
    method: route.method,
    path: `/internal/v1${route.path}`,
    authority,
  });

const routeAt = (index: number): RouteCase => {
  const route = routes[index];
  if (!route) throw new Error("Missing media route fixture");
  return route;
};

const mutations = (engine: ReturnType<typeof createEngine>) =>
  Object.values(engine).filter((method) => method !== engine.close && method !== engine.getHealth);

describe("media control authentication", () => {
  it.each(["relayrtc-api", "relayrtc-console"] as const)(
    "accepts room cleanup issued by %s",
    async (service) => {
      const engine = createEngine();
      const app = buildApp({ config, engine });
      const path = "/internal/v1/rooms/room_1";
      const authorization = createMediaControlToken(secret, {
        service,
        method: "DELETE",
        path,
        authority: room,
      });
      const response = await app.inject({
        method: "DELETE",
        url: path,
        headers: { authorization: `Bearer ${authorization}` },
      });
      expect(response.statusCode).toBe(204);
      expect(engine.closeRoom).toHaveBeenCalledWith({ roomId: "room_1" });
      await app.close();
    },
  );

  it("preserves engine ownership checks after service authentication", async () => {
    const engine = createEngine();
    const app = buildApp({ config, engine });
    const route = routeAt(6);
    engine.connectParticipantTransport.mockRejectedValue(
      new MediaEngineError("FORBIDDEN", "The transport belongs to another participant"),
    );
    const response = await app.inject({
      method: route.method,
      url: `/internal/v1${route.path}`,
      ...(route.body ? { payload: route.body } : {}),
      headers: { authorization: `Bearer ${tokenFor(route)}` },
    });
    expect(response.statusCode).toBe(403);
    expect(engine.connectParticipantTransport).toHaveBeenCalledWith({
      roomId: "room_1",
      participantId: "participant_1",
      transportId: "transport_1",
      dtlsParameters: {},
    });
    await app.close();
  });

  for (const route of routes) {
    const url = `/internal/v1${route.path}`;

    it.each(["missing", "wrong", "raw-secret", "expired"])(
      `rejects %s credentials for ${route.method} ${route.path}`,
      async (credential) => {
        const engine = createEngine();
        const app = buildApp({ config, engine });
        const token =
          credential === "raw-secret"
            ? secret
            : credential === "expired"
              ? createMediaControlToken(
                  secret,
                  {
                    service: "relayrtc-signaling",
                    method: route.method,
                    path: url,
                    authority: route.authority,
                  },
                  Math.floor(Date.now() / 1000) - 31,
                )
              : tokenFor(route, route.authority, "wrong-media-secret-at-least-32-characters");
        const response = await app.inject({
          method: route.method,
          url,
          ...(route.body ? { payload: route.body } : {}),
          headers: credential === "missing" ? {} : { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
        for (const method of mutations(engine)) expect(method).not.toHaveBeenCalled();
        await app.close();
      },
    );

    it(`accepts the scoped service grant for ${route.method} ${route.path}`, async () => {
      const app = buildApp({ config, engine: createEngine() });
      const response = await app.inject({
        method: route.method,
        url,
        ...(route.body ? { payload: route.body } : {}),
        headers: { authorization: `Bearer ${tokenFor(route)}` },
      });
      expect(response.statusCode, response.body).toBe(route.status);
      await app.close();
    });

    if (route.authority.kind !== "capacity") {
      const authority = route.authority;
      it(`rejects another room's grant for ${route.method} ${route.path}`, async () => {
        const engine = createEngine();
        const app = buildApp({ config, engine });
        const response = await app.inject({
          method: route.method,
          url,
          ...(route.body ? { payload: route.body } : {}),
          headers: {
            authorization: `Bearer ${tokenFor(route, { ...authority, roomId: "room_other" })}`,
          },
        });
        expect(response.statusCode).toBe(403);
        for (const method of mutations(engine)) expect(method).not.toHaveBeenCalled();
        await app.close();
      });
    }

    if (route.authority.kind === "participant" || route.authority.kind === "participant-cleanup") {
      const authority = route.authority;
      it(`checks participant scope for ${route.method} ${route.path}`, async () => {
        const engine = createEngine();
        const app = buildApp({ config, engine });
        const response = await app.inject({
          method: route.method,
          url,
          ...(route.body ? { payload: route.body } : {}),
          headers: {
            authorization: `Bearer ${tokenFor(route, { ...authority, participantId: "participant_other" })}`,
          },
        });
        const hasParticipant =
          route.body?.participantId !== undefined || route.path.includes("/participants/");
        expect(response.statusCode).toBe(hasParticipant ? 403 : route.status);
        if (hasParticipant)
          for (const method of mutations(engine)) expect(method).not.toHaveBeenCalled();
        await app.close();
      });
    }
  }

  it.each(["/health", "/ready"])("keeps %s accessible without control credentials", async (url) => {
    const app = buildApp({ config, engine: createEngine() });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    await app.close();
  });

  it("rejects a scoped grant reused for a different method or resource", async () => {
    const app = buildApp({ config, engine: createEngine() });
    const authorization = `Bearer ${tokenFor(routeAt(5))}`;
    for (const request of [
      { method: "DELETE" as const, url: "/internal/v1/rooms/room_1" },
      { method: "POST" as const, url: "/internal/v1/rooms/room_2/transports" },
      { method: "PATCH" as const, url: "/internal/v1/rooms/room_1/transports/transport_other" },
    ]) {
      expect((await app.inject({ ...request, headers: { authorization } })).statusCode).toBe(403);
    }
    await app.close();
  });

  it("prevents room and participant authority from becoming administrative cleanup", async () => {
    const app = buildApp({ config, engine: createEngine() });
    const cleanup = routeAt(routes.length - 1);
    for (const authority of [room, participant]) {
      const response = await app.inject({
        method: cleanup.method,
        url: `/internal/v1${cleanup.path}`,
        headers: { authorization: `Bearer ${tokenFor(cleanup, authority)}` },
      });
      expect(response.statusCode).toBe(403);
    }
    await app.close();
  });

  it("rejects a conflicting session identifier before running the engine", async () => {
    const engine = createEngine();
    const app = buildApp({ config, engine });
    const route = routeAt(5);
    const response = await app.inject({
      method: route.method,
      url: `/internal/v1${route.path}`,
      payload: { ...route.body, sessionId: "session_other" },
      headers: { authorization: `Bearer ${tokenFor(route)}` },
    });
    expect(response.statusCode).toBe(403);
    expect(engine.createParticipantTransport).not.toHaveBeenCalled();
    await app.close();
  });
});
