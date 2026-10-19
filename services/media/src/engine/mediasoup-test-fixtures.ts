import type {
  Consumer,
  Producer,
  Router,
  WebRtcServer,
  WebRtcTransport,
  Worker,
} from "mediasoup/types";
import { vi } from "vitest";

import type { MediasoupWorkerFactory } from "./mediasoup-factory.js";

export interface MediasoupTestHarness {
  consumers: Consumer[];
  factory: MediasoupWorkerFactory;
  producers: Producer[];
  routerFactories: ReturnType<typeof vi.fn>[];
  workers: Worker[];
}

const createTransport = (
  id: string,
  consumers: Consumer[],
  producers: Producer[],
): WebRtcTransport => {
  let consumerIndex = 0;
  let producerIndex = 0;
  return {
    appData: {},
    close: vi.fn(),
    closed: false,
    on: vi.fn(),
    dtlsState: "connected",
    iceState: "connected",
    connect: vi.fn(() => Promise.resolve()),
    consume: vi.fn((options: { paused?: boolean; producerId: string }) => {
      const producer = producers.find((candidate) => candidate.id === options.producerId);
      if (!producer) return Promise.reject(new Error(`Producer ${options.producerId} not found`));
      const consumer = {
        close: vi.fn(),
        id: `consumer-${id}-${String(consumerIndex++)}`,
        kind: producer.kind,
        type: (producer.rtpParameters.encodings?.length ?? 0) > 1 ? "simulcast" : "simple",
        observer: { once: vi.fn() },
        producerId: options.producerId,
        paused: options.paused ?? false,
        pause: vi.fn(function (this: { paused: boolean }) {
          this.paused = true;
          return Promise.resolve();
        }),
        resume: vi.fn(function (this: { paused: boolean }) {
          this.paused = false;
          return Promise.resolve();
        }),
        setPreferredLayers: vi.fn(() => Promise.resolve()),
        setPriority: vi.fn(() => Promise.resolve()),
        rtpParameters: producer.rtpParameters,
      } as unknown as Consumer;
      consumers.push(consumer);
      return Promise.resolve(consumer);
    }),
    dtlsParameters: { fingerprints: [], role: "auto" },
    iceCandidates: [{ foundation: "test", ip: "127.0.0.1", port: 40_000 }],
    iceParameters: { iceLite: true, password: "password", usernameFragment: "username" },
    id,
    observer: { once: vi.fn() },
    produce: vi.fn(
      (options: {
        appData: Record<string, unknown>;
        kind: "audio" | "video";
        rtpParameters: Readonly<Record<string, unknown>>;
      }) => {
        const producer = {
          appData: options.appData,
          close: vi.fn(),
          id: `producer-${id}-${String(producerIndex++)}`,
          kind: options.kind,
          paused: false,
          pause: vi.fn(function (this: { paused: boolean }) {
            this.paused = true;
            return Promise.resolve();
          }),
          resume: vi.fn(function (this: { paused: boolean }) {
            this.paused = false;
            return Promise.resolve();
          }),
          observer: { once: vi.fn() },
          rtpParameters: options.rtpParameters,
        } as unknown as Producer;
        producers.push(producer);
        return Promise.resolve(producer);
      },
    ),
    restartIce: vi.fn(() =>
      Promise.resolve({ iceLite: true, password: "new-password", usernameFragment: "new-user" }),
    ),
  } as unknown as WebRtcTransport;
};

const createRouter = (id: string, consumers: Consumer[], producers: Producer[]): Router => {
  let transportIndex = 0;
  return {
    canConsume: vi.fn(() => true),
    close: vi.fn(),
    closed: false,
    createWebRtcTransport: vi.fn(() =>
      Promise.resolve(
        createTransport(`transport-${id}-${String(transportIndex++)}`, consumers, producers),
      ),
    ),
    id,
    observer: { once: vi.fn() },
    rtpCapabilities: { codecs: [] },
  } as unknown as Router;
};

export const createMediasoupTestHarness = (): MediasoupTestHarness => {
  const consumers: Consumer[] = [];
  const producers: Producer[] = [];
  const workers: Worker[] = [];
  const routerFactories: ReturnType<typeof vi.fn>[] = [];
  const factory: MediasoupWorkerFactory = vi.fn(() => {
    const index = workers.length;
    let routerIndex = 0;
    const createRouterMock = vi.fn(() =>
      Promise.resolve(
        createRouter(`${String(index)}-${String(routerIndex++)}`, consumers, producers),
      ),
    );
    routerFactories.push(createRouterMock);
    const worker = {
      close: vi.fn(),
      closed: false,
      createRouter: createRouterMock,
      createWebRtcServer: vi.fn(() =>
        Promise.resolve({
          close: vi.fn(),
          id: `server-${String(index)}`,
        } as unknown as WebRtcServer),
      ),
      getResourceUsage: vi.fn(() => Promise.resolve({})),
      id: `worker-${String(index)}`,
      on: vi.fn(),
    } as unknown as Worker;
    workers.push(worker);
    return Promise.resolve(worker);
  });
  return { consumers, factory, producers, routerFactories, workers };
};
