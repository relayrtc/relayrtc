import { persistUsageSample } from "../usage/usage-sample-batch.js";
import { StreamingExports, type StreamingExportRequest } from "./streaming-export.js";
import { setTimeout as delay } from "node:timers/promises";
import type { RoomRuntimeStore } from "./room-runtime-store.js";
import { randomUUID } from "node:crypto";
import { MediaDurationMeter } from "../usage/media-duration-meter.js";
import type {
  Consumer,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Router,
  RouterRtpCodecCapability,
  WebRtcServer,
  WebRtcTransport,
  Worker,
  WorkerSettings,
} from "mediasoup/types";
import { roomQualityModeSettings, type ConnectionQuality } from "@relayrtc/types";

import type { MediaConfig } from "../config/environment.js";
import { MediaEngineError } from "./errors.js";
import type {
  MediaEngine,
  MediaEngineCapacity,
  MediaEngineHealth,
  IngestSubscriberStatsRequest,
  MediaRoomRequest,
  ConnectTransportRequest,
  ControlTrackRequest,
  ParticipantTransport,
  ParticipantTransportRequest,
  PublishedTrack,
  PublishTrackRequest,
  RemoveTrackRequest,
  ResumeSubscriptionRequest,
  RemoveParticipantRequest,
  RestartTransportRequest,
  SetPriorityRequest,
  SetParticipantQualityModeRequest,
  SetSubscriptionQualityRequest,
  SubscribeTrackRequest,
  TrackSubscription,
} from "./media-engine.js";
import type { MediasoupWorkerFactory } from "./mediasoup-factory.js";
import type { QualityEventPublisher } from "../quality/quality-event-publisher.js";
import { qualityEvent } from "../quality/quality-event-publisher.js";
import { QualityObservationQueue } from "../quality/quality-event-outbox.js";
import {
  allocateSubscriberBudget,
  availableVideoLayers,
  qualityRank,
  type BudgetTrack,
  type VideoLayer,
} from "./subscriber-budget.js";
import type { QualityMetricsStore } from "../quality/quality-metrics-store.js";
import type { MediaUsageMetric, MediaUsageMetricsStore } from "../usage/usage-metrics-store.js";
import { classifyConnectionQuality, intervalNetworkStats } from "../quality/quality-model.js";
import {
  type MediaPriority,
  type SelectedVideoQuality,
  type SubscriberNetworkStats,
  type SubscriberQualityMode,
} from "./quality-controller.js";

const mediaCodecs: RouterRtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48_000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90_000 },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90_000,
    parameters: {
      "level-asymmetry-allowed": 1,
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
    },
  },
];

interface WorkerSlot {
  index: number;
  instanceId: string;
  allocating: Set<string>;
  alive: boolean;
  rooms: number;
  webRtcServer: WebRtcServer;
  worker: Worker;
}

interface RoomState {
  closing: boolean;
  reservations: { transports: number; producers: number; consumers: number };
  closingParticipants: Set<string>;
  removingParticipants: Map<string, number>;
  pendingParticipants: Map<string, number>;
  participantReservations: Map<
    string,
    { transports: number; producers: number; consumers: number }
  >;
  durationMeter: MediaDurationMeter | undefined;
  consumers: Map<string, ConsumerState>;
  consumerUsage: Map<string, UsageSampleState>;
  participantPriorities: Map<string, MediaPriority>;
  participantQualities: Map<string, ConnectionQuality>;
  participantQualityPreferences: Map<string, SubscriberQualityMode>;
  participantStats: Map<string, SubscriberNetworkStats>;
  statsReceived: Map<string, number>;
  qualityOperations: Map<string, Promise<void>>;
  publicParticipants: Map<string, string>;
  qualityPublished: Map<string, number>;
  producers: Map<string, Producer>;
  producerUsage: Map<string, UsageSampleState>;
  router: Router;
  slot: WorkerSlot;
  transports: Map<string, TransportState>;
}

export interface MediaQualityOptions {
  roomRuntimeStore?: RoomRuntimeStore;
  onWorkerError?: (error: unknown) => void;
  onWorkerExhausted?: () => void;
  eventPublisher?: QualityEventPublisher;
  metricsStore?: QualityMetricsStore;
  usageMetricsStore?: MediaUsageMetricsStore;
  onUsageError?: (error: unknown) => void;
  onQualityError?: (error: unknown) => void;
}

interface ConsumerState {
  negotiationTimer?: ReturnType<typeof setTimeout>;
  consumer: Consumer;
  participantId: string;
  quality: SubscriberQualityMode;
  selectedQuality: SelectedVideoQuality | null;
  selectedLayer?: number;
  upgradeCandidate?: string;
  upgradeSamples?: number;
}

interface TransportState {
  connectionTimer?: ReturnType<typeof setTimeout>;
  direction: "receive" | "send";
  participantId: string;
  transport: WebRtcTransport;
}

interface UsageSampleState {
  pending?: {
    id: string;
    bytes: number;
    sampledAt: number;
    metrics: Partial<Record<MediaUsageMetric, number>>;
  };
  recording?: Promise<void> | undefined;
  bytes: number;
  sampledAt: number;
}

export class MediasoupWorkerPool implements MediaEngine {
  readonly #streamingExports = new StreamingExports();
  createStreamingExport(request: StreamingExportRequest) {
    const room = this.#getRoom(request.roomId);
    return this.#streamingExports.create(request, room.router, room.producers);
  }
  controlStreamingExport(exportId: string, action: "resume" | "renew" | "close") {
    return this.#streamingExports.control(exportId, action);
  }
  readonly #config: MediaConfig;
  readonly #createWorker: MediasoupWorkerFactory;
  readonly #quality: MediaQualityOptions;
  readonly #qualityObservations: QualityObservationQueue;
  readonly #pendingRooms = new Map<string, Promise<void>>();
  readonly #rooms = new Map<string, RoomState>();
  readonly #terminalOperations = new Map<string, Promise<void>>();
  readonly #retiredSamples = new Map<UsageSampleState, string>();
  readonly #workers: WorkerSlot[] = [];
  readonly #recoveryAbort = new AbortController();
  readonly #replacements = new Map<number, Promise<void>>();
  readonly #exhaustedWorkers = new Set<number>();
  readonly #replacementAttempts = new Map<number, number>();
  readonly #failedRooms = new Map<string, { room?: RoomState }>();
  #failureFlush: Promise<void> | null = null;
  #failureTimer: ReturnType<typeof setTimeout> | undefined;
  #starting: Promise<void> | null = null;
  #closed = false;
  #usageFlush: Promise<void> | null = null;

  constructor(
    config: MediaConfig,
    createWorker: MediasoupWorkerFactory,
    quality: MediaQualityOptions = {},
  ) {
    this.#config = config;
    this.#createWorker = createWorker;
    this.#quality = quality;
    this.#qualityObservations = new QualityObservationQueue(
      quality.metricsStore,
      quality.eventPublisher,
      quality.onQualityError,
    );
  }

  async start(): Promise<void> {
    if (this.#closed) throw new MediaEngineError("NOT_READY", "The media engine is closed");
    if (this.#starting) return this.#starting;
    if (this.#workers.length === this.#config.workerCount) {
      if (this.#workers.some((slot) => !slot.alive))
        throw new MediaEngineError(
          "NOT_READY",
          "Media worker recovery is in progress or exhausted",
        );
      return;
    }
    this.#starting = (async () => {
      try {
        for (let index = 0; index < this.#config.workerCount; index += 1) {
          this.#workers[index] = await this.#openWorker(index);
        }
      } catch (error) {
        await this.close();
        throw error;
      }
    })().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #openWorker(index: number): Promise<WorkerSlot> {
    if (this.#closed) throw new MediaEngineError("NOT_READY", "The media engine is closed");
    const instanceId = randomUUID();
    const worker = await this.#createWorker({
      ...this.#workerSettings(),
      appData: { nodeId: this.#config.nodeId, workerIndex: index, instanceId },
    });
    try {
      const webRtcServer = await worker.createWebRtcServer({
        appData: { nodeId: this.#config.nodeId, workerIndex: index },
        listenInfos: ["udp", "tcp"].map((protocol) => ({
          announcedAddress: this.#config.rtcAnnouncedAddress,
          ip: this.#config.rtcListenIp,
          port: this.#config.rtcPort + index,
          protocol: protocol as "udp" | "tcp",
        })),
      });
      if (this.#isClosed() || worker.closed) {
        webRtcServer.close();
        throw new MediaEngineError("NOT_READY", "The media worker closed during initialization");
      }
      const slot: WorkerSlot = {
        index,
        instanceId,
        allocating: new Set(),
        alive: true,
        rooms: 0,
        webRtcServer,
        worker,
      };
      worker.on("died", () => {
        this.#handleWorkerDeath(slot);
      });
      return slot;
    } catch (error) {
      worker.close();
      throw error;
    }
  }

  async #recoverWorker(index: number): Promise<void> {
    while (!this.#closed) {
      const attempt = (this.#replacementAttempts.get(index) ?? 0) + 1;
      if (attempt > 5) {
        this.#exhaustedWorkers.add(index);
        this.#quality.onWorkerExhausted?.();
        return;
      }
      this.#replacementAttempts.set(index, attempt);
      try {
        await delay(Math.min(4_000, 250 * 2 ** (attempt - 1)), undefined, {
          signal: this.#recoveryAbort.signal,
        });
        const replacement = await this.#openWorker(index);
        this.#workers[index] = replacement;
        if (!replacement.alive || replacement.worker.closed)
          throw new MediaEngineError(
            "NOT_READY",
            "The replacement worker died during initialization",
          );
        return;
      } catch (error) {
        if (this.#isClosed()) return;
        this.#quality.onWorkerError?.(error);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed && this.#workers.length === 0) return;
    this.#streamingExports.closeAll();
    this.#closed = true;
    this.#recoveryAbort.abort();
    clearTimeout(this.#failureTimer);
    await Promise.allSettled(this.#replacements.values());
    await this.#flushFailures();
    if (this.#usageFlush) await this.#usageFlush;
    for (const room of this.#rooms.values())
      for (const producer of room.producers.values()) room.durationMeter?.stop(producer.id);
    await Promise.all([...this.#rooms.keys()].map((roomId) => this.closeRoom({ roomId })));
    await Promise.allSettled(this.#pendingRooms.values());
    await this.#flushFailures();
    for (const room of this.#rooms.values()) room.router.close();
    await this.#qualityObservations.close();
    await this.#retryRetiredSamples();
    if (this.#retiredSamples.size > 0)
      throw new Error("Media usage checkpoints remain pending during shutdown");
    this.#rooms.clear();
    for (const slot of this.#workers) {
      slot.alive = false;
      slot.webRtcServer.close();
      slot.worker.close();
    }
    this.#workers.length = 0;
  }

  createRoom(request: MediaRoomRequest): Promise<void> {
    this.#assertReady();
    if (this.#failedRooms.has(request.roomId))
      throw new MediaEngineError("NOT_READY", "The room is awaiting failure cleanup");
    if (this.#rooms.has(request.roomId)) return Promise.resolve();
    const pending = this.#pendingRooms.get(request.roomId);
    if (pending) return pending;
    const creation = this.#createRoom(request).finally(() => {
      this.#pendingRooms.delete(request.roomId);
    });
    this.#pendingRooms.set(request.roomId, creation);
    return creation;
  }

  async #createRoom(request: MediaRoomRequest): Promise<void> {
    const slot = this.#selectWorker();
    slot.rooms += 1;
    slot.allocating.add(request.roomId);
    let router: Router;
    try {
      await this.#quality.roomRuntimeStore?.allocated(request.roomId, slot.instanceId);
      if (!this.#slotAvailable(slot))
        throw new MediaEngineError("NOT_READY", "The media worker is unavailable");
      router = await slot.worker.createRouter({
        appData: { roomId: request.roomId },
        mediaCodecs,
      });
    } catch (error) {
      slot.allocating.delete(request.roomId);
      slot.rooms = Math.max(0, slot.rooms - 1);
      this.#failedRooms.set(request.roomId, {});
      void this.#flushFailures();
      throw error;
    }
    slot.allocating.delete(request.roomId);
    if (!this.#slotAvailable(slot) || router.closed) {
      router.close();
      this.#failedRooms.set(request.roomId, {});
      void this.#flushFailures();
      throw new MediaEngineError("NOT_READY", "The media worker closed during room allocation");
    }
    const state: RoomState = {
      closing: false,
      reservations: { transports: 0, producers: 0, consumers: 0 },
      closingParticipants: new Set(),
      removingParticipants: new Map(),
      pendingParticipants: new Map(),
      participantReservations: new Map(),
      consumers: new Map(),
      consumerUsage: new Map(),
      durationMeter: this.#quality.usageMetricsStore
        ? new MediaDurationMeter(this.#quality.usageMetricsStore)
        : undefined,
      participantPriorities: new Map(),
      participantQualities: new Map(),
      participantQualityPreferences: new Map(),
      participantStats: new Map(),
      statsReceived: new Map(),
      qualityOperations: new Map(),
      publicParticipants: new Map(),
      qualityPublished: new Map(),
      producers: new Map(),
      producerUsage: new Map(),
      router,
      slot,
      transports: new Map(),
    };
    this.#rooms.set(request.roomId, state);
    router.observer.once("close", () => {
      if (slot.worker.closed && !this.#closed) this.#handleWorkerDeath(slot);
      if (this.#rooms.get(request.roomId) !== state) return;
      this.#rooms.delete(request.roomId);
      slot.rooms = Math.max(0, slot.rooms - 1);
    });
  }

  closeRoom(request: MediaRoomRequest): Promise<void> {
    return this.#serializeTerminal(request.roomId, () => this.#closeRoom(request));
  }

  async #closeRoom(request: MediaRoomRequest): Promise<void> {
    const room = this.#rooms.get(request.roomId);
    if (!room) return;
    room.closing = true;
    await Promise.all([
      ...[...room.consumers.values()].map((state) =>
        this.#recordConsumerUsage(
          request.roomId,
          state.consumer,
          room.consumerUsage.get(state.consumer.id),
        ),
      ),
      ...[...room.producers.values()].map((producer) =>
        this.#recordProducerUsage(request.roomId, producer, room.producerUsage.get(producer.id)),
      ),
    ]);
    for (const producer of room.producers.values()) room.durationMeter?.stop(producer.id);
    await this.#flushDurations(request.roomId, room);
    room.router.close();
  }

  getRouterCapabilities(request: MediaRoomRequest): Promise<Readonly<Record<string, unknown>>> {
    const room = this.#getRoom(request.roomId);
    return Promise.resolve(room.router.rtpCapabilities);
  }

  async createParticipantTransport(
    request: ParticipantTransportRequest,
  ): Promise<ParticipantTransport> {
    const room = this.#getRoom(request.roomId);
    const release = this.#reserve(
      room,
      "transports",
      this.#config.maxTransportsPerRoom,
      request.participantId,
    );
    let transport;
    try {
      transport = await room.router.createWebRtcTransport({
        appData: {
          direction: request.direction,
          participantId: request.participantId,
          roomId: request.roomId,
        },
        enableTcp: true,
        enableUdp: true,
        preferUdp: true,
        webRtcServer: room.slot.webRtcServer,
      });
      if (!this.#allocationActive(room, request.participantId) || transport.closed) {
        transport.close();
        throw new MediaEngineError("NOT_READY", "The participant or room closed during allocation");
      }
    } finally {
      release();
    }
    room.transports.set(transport.id, {
      direction: request.direction,
      participantId: request.participantId,
      transport,
    });
    const updateDurations = () => {
      if (request.direction !== "send") return;
      const connected =
        !transport.closed &&
        transport.dtlsState === "connected" &&
        (transport.iceState === "connected" || transport.iceState === "completed");
      const at = Date.now();
      for (const producer of room.producers.values()) {
        if (producer.appData.transportId !== transport.id) continue;
        if (connected && !producer.paused && !producer.closed)
          room.durationMeter?.start(
            producer.id,
            request.participantId,
            String(producer.appData.trackType),
            at,
          );
        else room.durationMeter?.stop(producer.id, at);
      }
    };
    transport.on("icestatechange", updateDurations);
    transport.on("dtlsstatechange", updateDurations);
    transport.observer.once("close", () => {
      updateDurations();
      clearTimeout(room.transports.get(transport.id)?.connectionTimer);
      room.transports.delete(transport.id);
    });
    const iceCandidates = [...transport.iceCandidates];
    for (const address of this.#config.rtcAdditionalAnnouncedAddresses ?? []) {
      for (const candidate of transport.iceCandidates) {
        if (
          iceCandidates.some(
            (existing) => existing.address === address && existing.protocol === candidate.protocol,
          )
        )
          continue;
        iceCandidates.push({
          ...candidate,
          address,
          ip: address,
          foundation: `${candidate.foundation}-${String(iceCandidates.length)}`,
        });
      }
    }
    return {
      direction: request.direction,
      dtlsParameters: transport.dtlsParameters as unknown as Readonly<Record<string, unknown>>,
      iceCandidates: iceCandidates as unknown as readonly Readonly<Record<string, unknown>>[],
      iceParameters: transport.iceParameters as unknown as Readonly<Record<string, unknown>>,
      id: transport.id,
    };
  }

  async connectParticipantTransport(request: ConnectTransportRequest): Promise<void> {
    const room = this.#getRoom(request.roomId);
    const transport = this.#getOwnedTransport(room, request.transportId, request.participantId);
    await transport.connect({ dtlsParameters: request.dtlsParameters as never });
    const state = room.transports.get(transport.id);
    if (!state || transport.closed)
      throw new MediaEngineError("NOT_READY", "The transport closed during connection setup");
    if (transport.dtlsState !== "connected" && !state.connectionTimer) {
      state.connectionTimer = setTimeout(() => {
        if (transport.dtlsState !== "connected") transport.close();
      }, 30_000);
      state.connectionTimer.unref();
      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "connected" || dtlsState === "closed" || dtlsState === "failed") {
          clearTimeout(state.connectionTimer);
          delete state.connectionTimer;
        }
        if (dtlsState === "failed") transport.close();
      });
    }
  }

  async restartParticipantTransport(
    request: RestartTransportRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    const room = this.#getRoom(request.roomId);
    const transport = this.#getOwnedTransport(room, request.transportId, request.participantId);
    return transport.restartIce();
  }

  listPublishedTracks(request: MediaRoomRequest): Promise<readonly PublishedTrack[]> {
    const room = this.#getRoom(request.roomId);
    return Promise.resolve(
      [...room.producers.values()].map((producer) => ({
        id: producer.id,
        kind: producer.kind,
        participantId: String(producer.appData.participantId),
        trackType: producer.appData.trackType as PublishedTrack["trackType"],
        priority:
          (producer.appData.priority as MediaPriority | undefined) ??
          room.participantPriorities.get(String(producer.appData.participantId)) ??
          (producer.appData.trackType === "screen_video" ? "high" : "normal"),
      })),
    );
  }

  getCapacity(): MediaEngineCapacity {
    let transports = 0;
    for (const room of this.#rooms.values()) transports += room.transports.size;
    return {
      maxRooms: this.#config.workerCount * this.#config.maxRoomsPerWorker,
      maxTransportsPerRoom: this.#config.maxTransportsPerRoom,
      rooms: this.#rooms.size,
      transports,
      workers: this.#workers.length,
    };
  }

  async getHealth(): Promise<MediaEngineHealth> {
    const liveWorkers = this.#workers.filter((slot) => slot.alive && !slot.worker.closed);
    const checks = await Promise.allSettled(
      liveWorkers.map((slot) => slot.worker.getResourceUsage()),
    );
    const workersAlive = checks.filter((check) => check.status === "fulfilled").length;
    return {
      capacity: this.getCapacity(),
      healthy:
        !this.#closed && this.#failedRooms.size === 0 && workersAlive === this.#config.workerCount,
      workersAlive,
    };
  }

  async publishTrack(request: PublishTrackRequest): Promise<PublishedTrack> {
    const room = this.#getRoom(request.roomId);
    const transport = this.#getParticipantTransport(
      room,
      request.transportId,
      request.participantId,
      "send",
    );
    const expectedKind =
      request.trackType === "audio" || request.trackType === "screen_audio" ? "audio" : "video";
    if (request.kind !== expectedKind) {
      throw new MediaEngineError(
        "INVALID_REQUEST",
        `Track type ${request.trackType} requires ${expectedKind} media`,
      );
    }
    const release = this.#reserve(
      room,
      "producers",
      this.#config.maxProducersPerRoom ?? 100,
      request.participantId,
    );
    let producer;
    try {
      producer = await transport.produce({
        appData: {
          participantId: request.participantId,
          roomId: request.roomId,
          trackType: request.trackType,
          transportId: request.transportId,
          ...(request.sourceHeight ? { sourceHeight: request.sourceHeight } : {}),
          ...(request.priority ? { priority: request.priority } : {}),
        },
        kind: request.kind,
        rtpParameters: request.rtpParameters as RtpParameters,
      });
      if (!this.#allocationActive(room, request.participantId) || producer.closed) {
        producer.close();
        throw new MediaEngineError("NOT_READY", "The participant or room closed during allocation");
      }
    } finally {
      release();
    }
    room.producers.set(producer.id, producer);
    if (
      transport.dtlsState === "connected" &&
      (transport.iceState === "connected" || transport.iceState === "completed")
    )
      room.durationMeter?.start(producer.id, request.participantId, request.trackType);
    room.producerUsage.set(producer.id, { bytes: 0, sampledAt: Date.now() });
    producer.observer.once("close", () => {
      room.durationMeter?.stop(producer.id);
      room.producers.delete(producer.id);
      this.#retireSample(request.roomId, room.producerUsage.get(producer.id));
      room.producerUsage.delete(producer.id);
    });
    return {
      id: producer.id,
      kind: producer.kind,
      participantId: request.participantId,
      trackType: request.trackType,
      priority:
        request.priority ??
        room.participantPriorities.get(request.participantId) ??
        (request.trackType === "screen_video" ? "high" : "normal"),
    };
  }

  controlTrack(request: ControlTrackRequest): Promise<void> {
    return this.#serializeTerminal(request.roomId, async () => {
      const room = this.#getRoom(request.roomId);
      const producer = room.producers.get(request.trackId);
      if (!producer || producer.closed)
        throw new MediaEngineError("NOT_FOUND", "The publication no longer exists");
      if (producer.appData.participantId !== request.participantId)
        throw new MediaEngineError("FORBIDDEN", "The publication belongs to another participant");
      if (request.action === "pause") {
        await producer.pause();
        room.durationMeter?.stop(producer.id);
      } else {
        await producer.resume();
        const transport = room.transports.get(String(producer.appData.transportId))?.transport;
        if (
          transport?.dtlsState === "connected" &&
          (transport.iceState === "connected" || transport.iceState === "completed")
        )
          room.durationMeter?.start(
            producer.id,
            request.participantId,
            String(producer.appData.trackType),
          );
      }
    });
  }

  async subscribeTrack(request: SubscribeTrackRequest): Promise<TrackSubscription> {
    const room = this.#getRoom(request.roomId);
    const producer = room.producers.get(request.trackId);
    if (!producer) {
      throw new MediaEngineError("NOT_FOUND", `Media track ${request.trackId} was not found`);
    }
    if (producer.appData.participantId === request.participantId) {
      throw new MediaEngineError(
        "INVALID_REQUEST",
        "Participants cannot subscribe to their own tracks",
      );
    }
    const transport = this.#getParticipantTransport(
      room,
      request.transportId,
      request.participantId,
      "receive",
    );
    const rtpCapabilities = request.rtpCapabilities as RtpCapabilities;
    if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new MediaEngineError(
        "INVALID_REQUEST",
        `Participant cannot consume media track ${request.trackId}`,
      );
    }
    const release = this.#reserve(
      room,
      "consumers",
      this.#config.maxConsumersPerRoom ?? 600,
      request.participantId,
    );
    let consumer;
    try {
      consumer = await transport.consume({
        appData: { participantId: request.participantId, roomId: request.roomId },
        paused: true,
        producerId: producer.id,
        rtpCapabilities,
      });
      if (!this.#allocationActive(room, request.participantId) || consumer.closed) {
        consumer.close();
        throw new MediaEngineError("NOT_READY", "The participant or room closed during allocation");
      }
    } finally {
      release();
    }
    const priority =
      (producer.appData.priority as MediaPriority | undefined) ??
      room.participantPriorities.get(String(producer.appData.participantId)) ??
      (producer.appData.trackType === "screen_video" ? "high" : "normal");
    const quality =
      request.quality ?? room.participantQualityPreferences.get(request.participantId) ?? "auto";
    const selectedQuality = consumer.kind === "video" ? "audio-only" : null;
    room.consumers.set(consumer.id, {
      consumer,
      participantId: request.participantId,
      quality,
      selectedQuality,
    });
    room.consumerUsage.set(consumer.id, { bytes: 0, sampledAt: Date.now() });
    consumer.observer.once("close", () => {
      clearTimeout(room.consumers.get(consumer.id)?.negotiationTimer);
      room.consumers.delete(consumer.id);
      this.#retireSample(request.roomId, room.consumerUsage.get(consumer.id));
      room.consumerUsage.delete(consumer.id);
    });
    try {
      await consumer.setPriority(priority === "high" ? 255 : priority === "low" ? 1 : 127);
      const state = room.consumers.get(consumer.id);
      if (!state || !this.#resourceOpen(consumer)) {
        throw new MediaEngineError("NOT_FOUND", "The subscription closed during negotiation");
      }
      state.negotiationTimer = setTimeout(() => {
        consumer.close();
      }, 60_000);
      state.negotiationTimer.unref();
    } catch (error) {
      consumer.close();
      throw error;
    }
    return {
      id: consumer.id,
      kind: consumer.kind,
      producerId: producer.id,
      rtpParameters: consumer.rtpParameters,
      trackId: producer.id,
      trackType: producer.appData.trackType as TrackSubscription["trackType"],
      priority,
      quality: selectedQuality,
    };
  }

  async resumeSubscription(request: ResumeSubscriptionRequest): Promise<void> {
    const room = this.#getRoom(request.roomId);
    const state = room.consumers.get(request.subscriptionId);
    if (!state) {
      throw new MediaEngineError(
        "NOT_FOUND",
        `Subscription ${request.subscriptionId} was not found`,
      );
    }
    if (state.participantId !== request.participantId) {
      throw new MediaEngineError("FORBIDDEN", "The subscription belongs to another participant");
    }
    clearTimeout(state.negotiationTimer);
    delete state.negotiationTimer;
    try {
      if (state.consumer.kind === "audio" && state.consumer.paused) await state.consumer.resume();
      await this.#serializeQuality(room, request.participantId, () =>
        this.#adaptSubscriber(room, request.participantId),
      );
    } catch (error) {
      state.consumer.close();
      throw error;
    }
  }

  removeSubscription(request: ResumeSubscriptionRequest): Promise<void> {
    return this.#serializeTerminal(request.roomId, () => this.#removeSubscription(request));
  }

  async #removeSubscription(request: ResumeSubscriptionRequest): Promise<void> {
    const room = this.#rooms.get(request.roomId);
    const state = room?.consumers.get(request.subscriptionId);
    if (!room || !state) return;
    if (state.participantId !== request.participantId) {
      throw new MediaEngineError("FORBIDDEN", "The subscription belongs to another participant");
    }
    await this.#recordConsumerUsage(
      request.roomId,
      state.consumer,
      room.consumerUsage.get(request.subscriptionId),
    );
    state.consumer.close();
  }

  async ingestSubscriberStats(request: IngestSubscriberStatsRequest): Promise<void> {
    const room = this.#getRoom(request.roomId);
    await this.#serializeQuality(room, request.participantId, async () => {
      const previous = room.participantStats.get(request.participantId);
      if (
        !Number.isFinite(request.stats.timestamp) ||
        request.stats.timestamp <= 0 ||
        request.stats.timestamp > Date.now() + 30_000 ||
        Date.now() - request.stats.timestamp > 30_000
      )
        throw new MediaEngineError(
          "INVALID_REQUEST",
          "Subscriber stats timestamp is stale or invalid",
        );
      if (previous && request.stats.timestamp <= previous.timestamp) return;
      let sample = request.stats;
      if (request.transportId) {
        const transport = this.#getParticipantTransport(
          room,
          request.transportId,
          request.participantId,
          "receive",
        );
        const reports = await transport.getStats();
        const estimate = reports[0]?.availableOutgoingBitrate;
        if (estimate !== undefined && Number.isFinite(estimate) && estimate >= 0)
          sample = {
            ...sample,
            availableIncomingBitrate:
              sample.availableIncomingBitrate === null
                ? estimate
                : Math.min(estimate, sample.availableIncomingBitrate),
          };
      }
      const stats = intervalNetworkStats(sample, previous);
      room.participantStats.set(request.participantId, sample);
      room.statsReceived.set(request.participantId, Date.now());
      room.publicParticipants.set(
        request.participantId,
        request.publicParticipantId ?? request.participantId,
      );
      await this.#adaptSubscriber(room, request.participantId, stats);
      this.#recordQuality(request.roomId, room, request.participantId, stats);
    });
  }

  async setSubscriptionQuality(request: SetSubscriptionQualityRequest): Promise<void> {
    const room = this.#getRoom(request.roomId);
    const state = room.consumers.get(request.subscriptionId);
    if (!state)
      throw new MediaEngineError(
        "NOT_FOUND",
        `Subscription ${request.subscriptionId} was not found`,
      );
    if (state.participantId !== request.participantId)
      throw new MediaEngineError("FORBIDDEN", "The subscription belongs to another participant");
    state.quality = request.quality;
    await this.#serializeQuality(room, request.participantId, () =>
      this.#adaptSubscriber(room, request.participantId, undefined, true),
    );
  }

  async setParticipantQualityMode(request: SetParticipantQualityModeRequest): Promise<void> {
    const room = this.#getRoom(request.roomId);
    const quality = roomQualityModeSettings[request.mode].receive;
    room.participantQualityPreferences.set(request.participantId, quality);
    for (const state of room.consumers.values())
      if (state.participantId === request.participantId) state.quality = quality;
    await this.#serializeQuality(room, request.participantId, () =>
      this.#adaptSubscriber(room, request.participantId, undefined, true),
    );
  }

  async setTrackPriority(request: SetPriorityRequest & { trackId: string }): Promise<void> {
    const room = this.#getRoom(request.roomId);
    const producer = room.producers.get(request.trackId);
    if (!producer)
      throw new MediaEngineError("NOT_FOUND", `Media track ${request.trackId} was not found`);
    if (producer.appData.participantId !== request.participantId)
      throw new MediaEngineError("FORBIDDEN", "A participant can only prioritize their own tracks");
    producer.appData.priority = request.priority;
    await this.#setProducerConsumerPriorities(room, producer.id, request.priority);
  }

  async setParticipantPriority(request: SetPriorityRequest): Promise<void> {
    const room = this.#getRoom(request.roomId);
    room.participantPriorities.set(request.participantId, request.priority);
    const producers = [...room.producers.values()].filter(
      (producer) =>
        producer.appData.participantId === request.participantId &&
        producer.appData.priority === undefined,
    );
    await Promise.all(
      producers.map((producer) =>
        this.#setProducerConsumerPriorities(room, producer.id, request.priority),
      ),
    );
  }

  removeTrack(request: RemoveTrackRequest): Promise<void> {
    return this.#serializeTerminal(request.roomId, () => this.#removeTrack(request));
  }

  async #removeTrack(request: RemoveTrackRequest): Promise<void> {
    const room = this.#getRoom(request.roomId);
    const producer = room.producers.get(request.trackId);
    if (!producer) return;
    if (producer.appData.participantId !== request.participantId) {
      throw new MediaEngineError("FORBIDDEN", "A participant can only remove their own tracks");
    }
    await this.#recordProducerUsage(request.roomId, producer, room.producerUsage.get(producer.id));
    for (const [consumerId, state] of room.consumers) {
      if (state.consumer.producerId === producer.id) {
        await this.#recordConsumerUsage(
          request.roomId,
          state.consumer,
          room.consumerUsage.get(consumerId),
        );
        state.consumer.close();
        room.consumers.delete(consumerId);
      }
    }
    room.durationMeter?.stop(producer.id);
    await this.#flushDurations(request.roomId, room);
    producer.close();
    room.producers.delete(producer.id);
  }

  removeParticipant(request: RemoveParticipantRequest): Promise<void> {
    return this.#serializeTerminal(request.roomId, () => this.#removeParticipant(request));
  }

  async #removeParticipant(request: RemoveParticipantRequest): Promise<void> {
    const room = this.#rooms.get(request.roomId);
    if (!room) return;
    room.closingParticipants.add(request.participantId);
    room.removingParticipants.set(
      request.participantId,
      (room.removingParticipants.get(request.participantId) ?? 0) + 1,
    );
    try {
      const ownedProducerIds = new Set(
        [...room.producers.values()]
          .filter((producer) => producer.appData.participantId === request.participantId)
          .map((producer) => producer.id),
      );
      for (const [consumerId, state] of room.consumers) {
        if (
          state.participantId === request.participantId ||
          ownedProducerIds.has(state.consumer.producerId)
        ) {
          await this.#recordConsumerUsage(
            request.roomId,
            state.consumer,
            room.consumerUsage.get(consumerId),
          );
          state.consumer.close();
          room.consumers.delete(consumerId);
        }
      }
      for (const producerId of ownedProducerIds) {
        const producer = room.producers.get(producerId);
        if (producer) {
          await this.#recordProducerUsage(
            request.roomId,
            producer,
            room.producerUsage.get(producerId),
          );
          room.durationMeter?.stop(producerId);
          await this.#flushDurations(request.roomId, room);
          producer.close();
        }
        room.producers.delete(producerId);
      }
      for (const [transportId, state] of room.transports) {
        if (state.participantId === request.participantId) {
          state.transport.close();
          room.transports.delete(transportId);
        }
      }
      room.participantPriorities.delete(request.participantId);
      room.participantQualities.delete(request.participantId);
      room.participantQualityPreferences.delete(request.participantId);
      room.participantStats.delete(request.participantId);
      room.statsReceived.delete(request.participantId);
      room.publicParticipants.delete(request.participantId);
      room.qualityPublished.delete(request.participantId);
    } finally {
      const removing = (room.removingParticipants.get(request.participantId) ?? 1) - 1;
      if (removing > 0) room.removingParticipants.set(request.participantId, removing);
      else {
        room.removingParticipants.delete(request.participantId);
        if (!room.pendingParticipants.has(request.participantId))
          room.closingParticipants.delete(request.participantId);
      }
    }
  }

  async #recordSample(
    roomId: string,
    sample: UsageSampleState | undefined,
    collect: () => Promise<{
      bytes: number;
      sampledAt: number;
      metrics: Partial<Record<MediaUsageMetric, number>>;
    }>,
  ): Promise<void> {
    const store = this.#quality.usageMetricsStore;
    if (!store || !sample) return;
    const operation = (sample.recording ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        try {
          if (sample.pending) await this.#persistSample(roomId, sample);
          let collected;
          try {
            collected = await collect();
          } catch (error) {
            this.#quality.onUsageError?.(error);
            return;
          }
          sample.pending = { id: randomUUID(), ...collected };
          await this.#persistSample(roomId, sample);
        } catch (error) {
          this.#quality.onUsageError?.(error);
          throw error;
        }
      });
    sample.recording = operation;
    try {
      await operation;
    } finally {
      if (sample.recording === operation) sample.recording = undefined;
    }
  }

  async #persistSample(roomId: string, sample: UsageSampleState): Promise<void> {
    const pending = sample.pending;
    const store = this.#quality.usageMetricsStore;
    if (!pending || !store) return;
    await persistUsageSample(
      store,
      roomId,
      pending.id,
      pending.metrics,
      new Date(pending.sampledAt),
    );
    sample.bytes = pending.bytes;
    sample.sampledAt = pending.sampledAt;
    delete sample.pending;
  }

  #serializeTerminal(roomId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#terminalOperations.get(roomId);
    const operation = previous ? previous.catch(() => undefined).then(work) : work();
    this.#terminalOperations.set(roomId, operation);
    return operation.finally(() => {
      if (this.#terminalOperations.get(roomId) === operation)
        this.#terminalOperations.delete(roomId);
    });
  }

  #retireSample(roomId: string, sample: UsageSampleState | undefined): void {
    if (sample && (sample.pending || sample.recording)) this.#retiredSamples.set(sample, roomId);
  }

  async #retryRetiredSamples(): Promise<void> {
    await Promise.allSettled(
      [...this.#retiredSamples].map(async ([sample, roomId]) => {
        try {
          await sample.recording?.catch(() => undefined);
          await this.#persistSample(roomId, sample);
          this.#retiredSamples.delete(sample);
        } catch (error) {
          this.#quality.onUsageError?.(error);
          throw error;
        }
      }),
    );
  }

  async #recordProducerUsage(
    roomId: string,
    producer: Producer,
    sample?: UsageSampleState,
  ): Promise<void> {
    await this.#recordSample(roomId, sample, async () => {
      const stats = await producer.getStats();
      const bytes = stats.reduce(
        (total, entry) => total + ("byteCount" in entry ? entry.byteCount : 0),
        0,
      );
      const sampledAt = Date.now();
      const delta = bytes >= (sample?.bytes ?? 0) ? bytes - (sample?.bytes ?? 0) : 0;
      const trackType = String(producer.appData.trackType);
      return {
        bytes,
        sampledAt,
        metrics: {
          sfuIngressBytes: delta,
          ...(trackType === "screen_video" || trackType === "screen_audio"
            ? { screenShareIngressBytes: delta }
            : {}),
        },
      };
    });
  }

  async #recordConsumerUsage(
    roomId: string,
    consumer: Consumer,
    sample?: UsageSampleState,
  ): Promise<void> {
    await this.#recordSample(roomId, sample, async () => {
      const stats = await consumer.getStats();
      const bytes = stats.reduce(
        (total, entry) => total + ("byteCount" in entry ? entry.byteCount : 0),
        0,
      );
      const delta = bytes >= (sample?.bytes ?? 0) ? bytes - (sample?.bytes ?? 0) : 0;
      const producer = this.#rooms.get(roomId)?.producers.get(consumer.producerId);
      return {
        bytes,
        sampledAt: Date.now(),
        metrics: {
          sfuEgressBytes: delta,
          ...(producer?.appData.trackType === "screen_video" ||
          producer?.appData.trackType === "screen_audio"
            ? { screenShareEgressBytes: delta }
            : {}),
        },
      };
    });
  }

  async flushUsage(): Promise<void> {
    if (this.#usageFlush) return this.#usageFlush;
    this.#usageFlush = this.#flushUsage().finally(() => {
      this.#usageFlush = null;
    });
    return this.#usageFlush;
  }

  async #flushDurations(roomId: string, room: RoomState): Promise<void> {
    try {
      await room.durationMeter?.flush(roomId, Date.now(), true);
    } catch (error) {
      this.#quality.onUsageError?.(error);
      throw error;
    }
  }

  async #flushUsage(): Promise<void> {
    await this.#retryRetiredSamples();
    await Promise.allSettled(
      [...this.#rooms.entries()].flatMap(([roomId, room]) => [
        this.#flushDurations(roomId, room),
        ...[...room.producers.values()].map((producer) =>
          this.#recordProducerUsage(roomId, producer, room.producerUsage.get(producer.id)),
        ),
        ...[...room.consumers.entries()].map(([consumerId, state]) =>
          this.#recordConsumerUsage(roomId, state.consumer, room.consumerUsage.get(consumerId)),
        ),
      ]),
    );
  }

  #serializeQuality(
    room: RoomState,
    participantId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const operation = (room.qualityOperations.get(participantId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task);
    room.qualityOperations.set(participantId, operation);
    void operation
      .finally(() => {
        if (room.qualityOperations.get(participantId) === operation)
          room.qualityOperations.delete(participantId);
      })
      .catch(() => undefined);
    return operation;
  }

  async #adaptSubscriber(
    room: RoomState,
    participantId: string,
    interval?: SubscriberNetworkStats,
    preferenceChanged = false,
  ): Promise<void> {
    if (room.closing || room.closingParticipants.has(participantId)) return;
    const states = [...room.consumers.values()].filter(
      (state) =>
        state.participantId === participantId && !state.consumer.closed && !state.negotiationTimer,
    );
    const tracks: BudgetTrack[] = [];
    for (const state of states) {
      if (state.consumer.kind !== "video") continue;
      const producer = room.producers.get(state.consumer.producerId);
      if (!producer || producer.closed) continue;
      tracks.push({
        id: state.consumer.id,
        preference: state.quality,
        current: state.selectedQuality,
        screen: producer.appData.trackType === "screen_video",
        priority:
          (producer.appData.priority as MediaPriority | undefined) ??
          room.participantPriorities.get(String(producer.appData.participantId)) ??
          (producer.appData.trackType === "screen_video" ? "high" : "normal"),
        layers: availableVideoLayers(producer, state.consumer),
      });
    }
    const cumulative = room.participantStats.get(participantId);
    const stale = (room.statsReceived.get(participantId) ?? 0) + 10_000 < Date.now();
    const stats =
      interval ??
      (cumulative ? { ...cumulative, packetsLost: 0, packetsReceived: 0, stale } : undefined);
    const allocation = allocateSubscriberBudget(
      tracks,
      stats,
      states.filter((state) => state.consumer.kind === "audio").length,
    );
    // Apply every downgrade first so temporary upgrades cannot overspend the connection budget.
    const choices = states
      .filter((state) => state.consumer.kind === "video")
      .map((state) => ({ state, layer: allocation.get(state.consumer.id) ?? null }));
    choices.sort(
      (left, right) =>
        Number((left.layer?.spatialLayer ?? -1) > (left.state.selectedLayer ?? -1)) -
        Number((right.layer?.spatialLayer ?? -1) > (right.state.selectedLayer ?? -1)),
    );
    for (const { state, layer } of choices) {
      const selected = layer?.quality ?? "audio-only";
      const upgrading =
        qualityRank[selected] > qualityRank[state.selectedQuality ?? "audio-only"] ||
        (layer?.spatialLayer ?? -1) > (state.selectedLayer ?? -1);
      if (upgrading && state.selectedQuality !== null && cumulative && !preferenceChanged) {
        const candidate = `${selected}:${String(layer?.spatialLayer)}`;
        if (state.upgradeCandidate !== candidate) {
          state.upgradeCandidate = candidate;
          state.upgradeSamples = 0;
        }
        if (interval) state.upgradeSamples = (state.upgradeSamples ?? 0) + 1;
        if ((state.upgradeSamples ?? 0) < 3) continue;
      } else {
        delete state.upgradeCandidate;
        delete state.upgradeSamples;
      }
      if (state.consumer.closed || state.negotiationTimer) continue;
      await this.#applyQuality(state.consumer, layer);
      state.selectedQuality = selected;
      if (layer) state.selectedLayer = layer.spatialLayer;
      else delete state.selectedLayer;
    }
  }

  #recordQuality(
    roomId: string,
    room: RoomState,
    sessionId: string,
    stats: SubscriberNetworkStats,
  ): void {
    const quality = classifyConnectionQuality(stats);
    const previous = room.participantQualities.get(sessionId);
    room.participantQualities.set(sessionId, quality);
    const participantId = room.publicParticipants.get(sessionId) ?? sessionId;
    const publish =
      previous !== quality || (room.qualityPublished.get(sessionId) ?? 0) + 10_000 <= Date.now();
    const event = publish
      ? {
          ...qualityEvent(roomId, participantId, previous ?? quality, quality),
          sessionId,
          metrics: {
            availableIncomingBitrate: stats.availableIncomingBitrate,
            incomingBitrate: stats.incomingBitrate ?? null,
            jitter: stats.jitter,
            roundTripTime: stats.roundTripTime,
            packetLossRatio: stats.packetLossRatio ?? null,
            timestamp: stats.timestamp,
            stale: stats.stale ?? false,
          },
        }
      : undefined;
    if (publish) room.qualityPublished.set(sessionId, Date.now());
    this.#qualityObservations.record(
      { roomId, participantId, quality, stats },
      event ? { type: "connection.quality.changed", event } : undefined,
    );
  }

  async checkQuality(): Promise<void> {
    for (const [roomId, room] of this.#rooms) {
      for (const [participantId, receivedAt] of room.statsReceived) {
        if (receivedAt + 10_000 > Date.now()) continue;
        const old = room.participantStats.get(participantId);
        if (!old) continue;
        await this.#serializeQuality(room, participantId, async () => {
          if ((room.statsReceived.get(participantId) ?? 0) + 10_000 > Date.now()) return;
          const stats = {
            ...old,
            timestamp: Date.now(),
            stale: true,
            availableIncomingBitrate: null,
            packetsReceived: 0,
            packetsLost: 0,
            incomingBitrate: null,
            packetLossRatio: null,
          };
          await this.#adaptSubscriber(room, participantId, stats);
          if (room.participantQualities.get(participantId) !== "lost")
            this.#recordQuality(roomId, room, participantId, stats);
        });
      }
    }
  }

  get qualityDelivery(): { pendingObservations: number; expiredObservations: number } {
    return {
      pendingObservations: this.#qualityObservations.backlog,
      expiredObservations: this.#qualityObservations.expired,
    };
  }

  async #applyQuality(consumer: Consumer, layer: VideoLayer | null): Promise<void> {
    if (!layer) {
      if (!consumer.paused) await consumer.pause();
      return;
    }
    if (consumer.type === "simulcast" || consumer.type === "svc")
      await consumer.setPreferredLayers({
        spatialLayer: layer.spatialLayer,
        temporalLayer: layer.temporalLayer,
      });
    if (consumer.paused) await consumer.resume();
  }

  async #setProducerConsumerPriorities(
    room: RoomState,
    producerId: string,
    priority: MediaPriority,
  ): Promise<void> {
    const value = priority === "high" ? 255 : priority === "low" ? 1 : 127;
    await Promise.all(
      [...room.consumers.values()]
        .filter((state) => state.consumer.producerId === producerId)
        .map((state) => state.consumer.setPriority(value)),
    );
  }

  #resourceOpen(resource: { closed: boolean }): boolean {
    return !resource.closed;
  }

  #allocationActive(room: RoomState, participantId: string): boolean {
    return (
      !this.#closed &&
      !room.closing &&
      !room.router.closed &&
      room.slot.alive &&
      !room.closingParticipants.has(participantId) &&
      [...this.#rooms.values()].includes(room)
    );
  }

  #reserve(
    room: RoomState,
    kind: "transports" | "producers" | "consumers",
    limit: number,
    participantId: string,
  ): () => void {
    if (!this.#allocationActive(room, participantId))
      throw new MediaEngineError("NOT_READY", "The participant or room is closing");
    if (room[kind].size + room.reservations[kind] >= limit)
      throw new MediaEngineError("CAPACITY_EXCEEDED", `Room ${kind} capacity is exhausted`);
    const participantLimit =
      kind === "transports"
        ? (this.#config.maxTransportsPerParticipant ?? 4)
        : kind === "producers"
          ? (this.#config.maxProducersPerParticipant ?? 4)
          : (this.#config.maxConsumersPerParticipant ?? 128);
    const owned =
      kind === "producers"
        ? [...room.producers.values()].filter(
            (producer) => producer.appData.participantId === participantId,
          ).length
        : [...(kind === "transports" ? room.transports.values() : room.consumers.values())].filter(
            (state) => state.participantId === participantId,
          ).length;
    const reservations = room.participantReservations.get(participantId) ?? {
      transports: 0,
      producers: 0,
      consumers: 0,
    };
    if (owned + reservations[kind] >= participantLimit)
      throw new MediaEngineError("CAPACITY_EXCEEDED", `Participant ${kind} capacity is exhausted`);
    reservations[kind]++;
    room.participantReservations.set(participantId, reservations);
    room.reservations[kind]++;
    room.pendingParticipants.set(
      participantId,
      (room.pendingParticipants.get(participantId) ?? 0) + 1,
    );
    return () => {
      room.reservations[kind]--;
      reservations[kind]--;
      const pending = (room.pendingParticipants.get(participantId) ?? 1) - 1;
      if (pending > 0) room.pendingParticipants.set(participantId, pending);
      else {
        room.pendingParticipants.delete(participantId);
        room.participantReservations.delete(participantId);
        if (!room.removingParticipants.has(participantId))
          room.closingParticipants.delete(participantId);
      }
    };
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #slotAvailable(slot: WorkerSlot): boolean {
    return slot.alive && !slot.worker.closed && !this.#closed;
  }

  #assertReady(): void {
    if (
      this.#closed ||
      this.#workers.length !== this.#config.workerCount ||
      !this.#workers.some((slot) => slot.alive && !slot.worker.closed)
    ) {
      throw new MediaEngineError("NOT_READY", "The media worker pool is not ready");
    }
  }

  #getRoom(roomId: string): RoomState {
    this.#assertReady();
    const room = this.#rooms.get(roomId);
    if (!room) throw new MediaEngineError("NOT_FOUND", `Media room ${roomId} was not found`);
    return room;
  }

  #getParticipantTransport(
    room: RoomState,
    transportId: string,
    participantId: string,
    direction: "receive" | "send",
  ): WebRtcTransport {
    const state = room.transports.get(transportId);
    if (!state) throw new MediaEngineError("NOT_FOUND", `Transport ${transportId} was not found`);
    if (state.participantId !== participantId) {
      throw new MediaEngineError("FORBIDDEN", "The transport belongs to another participant");
    }
    if (state.direction !== direction) {
      throw new MediaEngineError(
        "INVALID_REQUEST",
        `A ${direction} transport is required for this operation`,
      );
    }
    return state.transport;
  }

  #getOwnedTransport(room: RoomState, transportId: string, participantId: string): WebRtcTransport {
    const state = room.transports.get(transportId);
    if (!state) throw new MediaEngineError("NOT_FOUND", `Transport ${transportId} was not found`);
    if (state.participantId !== participantId) {
      throw new MediaEngineError("FORBIDDEN", "The transport belongs to another participant");
    }
    return state.transport;
  }

  #handleWorkerDeath(slot: WorkerSlot): void {
    if (!slot.alive || this.#closed) return;
    slot.alive = false;
    for (const roomId of slot.allocating) this.#failedRooms.set(roomId, {});
    for (const [roomId, room] of this.#rooms) {
      if (room.slot !== slot) continue;
      for (const producer of room.producers.values()) room.durationMeter?.stop(producer.id);
      this.#failedRooms.set(roomId, { room });
      this.#rooms.delete(roomId);
      room.router.close();
    }
    slot.rooms = 0;
    slot.webRtcServer.close();
    slot.worker.close();
    void this.#flushFailures();
    this.#scheduleRecovery(slot.index);
  }

  #scheduleRecovery(index: number): void {
    if (this.#closed || this.#replacements.has(index) || this.#exhaustedWorkers.has(index)) return;
    const recovery = this.#recoverWorker(index).finally(() => {
      this.#replacements.delete(index);
      if (!this.#workers[index]?.alive) this.#scheduleRecovery(index);
    });
    this.#replacements.set(index, recovery);
  }

  #flushFailures(): Promise<void> {
    if (this.#failureFlush) return this.#failureFlush;
    this.#failureFlush = (async () => {
      const pending = [...this.#failedRooms.entries()];
      try {
        await this.#quality.roomRuntimeStore?.failed(pending.map(([roomId]) => roomId));
        for (const [roomId, failure] of pending) {
          await failure.room?.durationMeter?.flush(roomId, Date.now(), true);
          if (this.#failedRooms.get(roomId) === failure) this.#failedRooms.delete(roomId);
        }
      } catch (error) {
        this.#quality.onWorkerError?.(error);
      }
    })().finally(() => {
      this.#failureFlush = null;
      if (this.#failedRooms.size > 0 && !this.#closed) {
        clearTimeout(this.#failureTimer);
        this.#failureTimer = setTimeout(() => {
          void this.#flushFailures();
        }, 2_000);
        this.#failureTimer.unref();
      }
    });
    return this.#failureFlush;
  }

  #selectWorker(): WorkerSlot {
    const candidates = this.#workers
      .filter(
        (slot) => slot.alive && !slot.worker.closed && slot.rooms < this.#config.maxRoomsPerWorker,
      )
      .sort((left, right) => left.rooms - right.rooms);
    const slot = candidates[0];
    if (!slot) throw new MediaEngineError("CAPACITY_EXCEEDED", "Media room capacity is exhausted");
    return slot;
  }

  #workerSettings(): WorkerSettings {
    return {
      appData: { nodeId: this.#config.nodeId },
      logLevel: this.#config.nodeEnvironment === "production" ? "warn" : "debug",
      logTags: ["ice", "dtls", "rtp", "rtcp"],
    };
  }
}
