import { Device, type types } from "mediasoup-client";
import type { RtcSessionScope } from "@relayrtc/protocol";
import type { Track, VideoQualityPreference } from "@relayrtc/types";
import type { RoomLocalTrackType } from "./room-media.js";
import { simulcastEncodings, normalizeRtcStats, type RtcQualityStats } from "./quality.js";
import { RoomError } from "./room-errors.js";
import type { RelayClientOptions } from "./room.js";
import type { SignalingClient } from "./signaling-client.js";

export interface LocalPublication {
  readonly info: Track;
  readonly muted: boolean;
  replaceTrack(track: MediaStreamTrack): Promise<void>;
  mute(): void;
  unmute(): void;
  close(): Promise<void>;
  dispose(): void;
}

export interface RemoteSubscription {
  readonly id: string;
  readonly track: MediaStreamTrack;
  setPaused(paused: boolean): void;
  close(): Promise<void>;
  dispose(): void;
}

interface PendingSubscription {
  cancelled: boolean;
  cancel?: () => void;
}

interface PublicationData extends types.AppData {
  sourceHeight?: number;
  trackType: RoomLocalTrackType;
  publication?: Track;
}

export class RoomRtc {
  readonly #transports: types.Transport[] = [];
  #closed = false;
  #sendTransport: types.Transport | undefined;
  #receiveTransport: types.Transport | undefined;
  #device: Device | undefined;
  #timeoutMs = 10_000;
  #scope: RtcSessionScope | undefined;
  #signaling: SignalingClient | undefined;
  #onFailure: ((error: RoomError) => void) | undefined;
  readonly #publications = new Set<LocalPublication>();
  readonly #subscriptions = new Map<
    string,
    { subscription: RemoteSubscription; onClosed: (error: RoomError) => void }
  >();
  readonly #pendingSubscriptions = new Map<string, PendingSubscription>();
  readonly #closedSubscriptions = new Set<string>();
  readonly #renewingIce = new Set<types.Transport>();
  #suspended = false;
  #iceOperation = Promise.resolve();
  readonly #deferredTracks = new Map<string, Track>();
  readonly #deferredSubscriptions = new Set<string>();
  #receiveStats: RtcQualityStats | undefined;
  #sendStats: RtcQualityStats | undefined;

  async getQualityStats(): Promise<RtcQualityStats> {
    this.#assertOpen();
    if (!this.#receiveTransport || !this.#sendTransport)
      throw new RoomError("NOT_CONNECTED", "Media transports are unavailable");
    const [receive, send] = await Promise.all([
      this.#receiveTransport.getStats(),
      this.#sendTransport.getStats(),
    ]);
    this.#assertOpen();
    const activeTracks = new Set(
      [...this.#subscriptions.values()].map(({ subscription }) => subscription.track.id),
    );
    const activeReceive = new Map<string, RTCStats>();
    receive.forEach((entry, id) => {
      const inbound = entry as RTCInboundRtpStreamStats;
      if (
        entry.type === "inbound-rtp" &&
        typeof inbound.trackIdentifier === "string" &&
        !activeTracks.has(inbound.trackIdentifier)
      )
        return;
      activeReceive.set(id, entry);
    });
    this.#receiveStats = normalizeRtcStats(activeReceive as RTCStatsReport, this.#receiveStats);
    this.#sendStats = normalizeRtcStats(send, this.#sendStats);
    return {
      ...this.#receiveStats,
      timestamp: Math.max(this.#receiveStats.timestamp, this.#sendStats.timestamp),
      stale: this.#receiveStats.stale === true && this.#sendStats.stale === true,
      bytesSent: this.#sendStats.bytesSent,
      outgoingBitrate: this.#sendStats.outgoingBitrate ?? null,
      availableOutgoingBitrate: this.#sendStats.availableOutgoingBitrate,
      streams: [...(this.#receiveStats.streams ?? []), ...(this.#sendStats.streams ?? [])],
    };
  }

  async reportQualityStats(stats: RtcQualityStats): Promise<void> {
    this.#assertOpen();
    const scope = this.#scope;
    if (!this.#signaling || !this.#receiveTransport || !scope || stats.timestamp <= 0) return;
    const accepted = await this.#signaling.request(
      "rtc.stats.report",
      {
        ...scope,
        transportId: this.#receiveTransport.id,
        stats: {
          availableIncomingBitrate: stats.availableIncomingBitrate,
          incomingBitrate: stats.incomingBitrate ?? null,
          jitter: stats.jitter,
          packetsLost: stats.packetsLost,
          packetsReceived: stats.packetsReceived,
          packetLossRatio: stats.packetLossRatio ?? null,
          roundTripTime: stats.roundTripTime,
          timestamp: stats.timestamp,
          stale: stats.stale ?? false,
        },
      },
      "rtc.stats.accepted",
    );
    this.#checkScope(accepted, scope);
  }

  async initialize(
    signaling: SignalingClient,
    scope: RtcSessionScope,
    options: RelayClientOptions,
    onFailure: (error: RoomError) => void,
  ): Promise<void> {
    this.#scope = scope;
    this.#signaling = signaling;
    this.#onFailure = onFailure;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
    const capabilities = await signaling.request("rtc.capabilities.get", scope, "rtc.capabilities");
    this.#assertOpen();
    const device = new Device();
    await device.load({
      routerRtpCapabilities: capabilities.routerCapabilities,
    });
    this.#device = device;
    this.#assertOpen();
    for (const direction of ["send", "receive"] as const) {
      const response = await signaling.request(
        "rtc.transport.create",
        { ...scope, direction },
        "rtc.transport.created",
      );
      this.#assertOpen();
      this.#checkScope(response, scope);
      if (response.direction !== direction)
        throw new RoomError(
          "PROTOCOL_ERROR",
          "The media transport direction does not match the request",
        );
      const transportOptions: types.TransportOptions = {
        id: response.transportId,
        iceParameters: response.iceParameters as unknown as types.IceParameters,
        iceCandidates: response.iceCandidates as unknown as types.IceCandidate[],
        dtlsParameters: response.dtlsParameters as unknown as types.DtlsParameters,
        ...(options.iceServers ? { iceServers: [...options.iceServers] } : {}),
        ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
      };
      const transport =
        direction === "send"
          ? device.createSendTransport(transportOptions)
          : device.createRecvTransport(transportOptions);
      this.#transports.push(transport);
      if (direction === "receive") this.#receiveTransport = transport;
      if (direction === "send") {
        this.#sendTransport = transport;
        transport.on("produce", ({ rtpParameters, appData }, callback, errback) => {
          const data = appData as PublicationData;
          void signaling
            .request(
              "rtc.track.publish",
              {
                ...scope,
                transportId: transport.id,
                trackType: data.trackType,
                rtpParameters,
                metadata: data.sourceHeight ? { sourceHeight: data.sourceHeight } : {},
              },
              "rtc.track.publish.accepted",
            )
            .then(async (published) => {
              this.#checkScope(published, scope);
              const info = published.track;
              if (
                info.roomId !== scope.roomId ||
                info.sessionId !== scope.sessionId ||
                info.type !== data.trackType ||
                info.state !== "published"
              ) {
                throw new RoomError(
                  "PROTOCOL_ERROR",
                  "The publication does not match the local track",
                );
              }
              data.publication = info;
              if (this.#closed) {
                await this.#unpublish(info);
                throw new RoomError("MEDIA_OPERATION_CANCELLED", "Media publication was cancelled");
              }
              callback({ id: info.id });
            })
            .catch((error: unknown) => {
              const failure =
                error instanceof RoomError
                  ? error
                  : new RoomError("MEDIA_PUBLISH_FAILED", "The local track could not be published");
              errback(failure);
              if (
                failure.code === "PROTOCOL_ERROR" ||
                failure.code === "REQUEST_TIMEOUT" ||
                failure.code === "CONNECTION_FAILED"
              )
                onFailure(failure);
            });
        });
      }
      transport.on("connect", ({ dtlsParameters }, callback, errback) => {
        void signaling
          .request(
            "rtc.transport.connect",
            {
              ...scope,
              transportId: transport.id,
              dtlsParameters,
            },
            "rtc.transport.connected",
          )
          .then((connected) => {
            this.#assertOpen();
            this.#checkScope(connected, scope);
            if (connected.transportId !== transport.id)
              throw new RoomError(
                "PROTOCOL_ERROR",
                "The connected media transport does not match the request",
              );
            callback();
          })
          .catch((error: unknown) => {
            const failure =
              error instanceof RoomError
                ? error
                : new RoomError("RTC_SETUP_FAILED", "The media transport could not connect");
            errback(failure);
            onFailure(failure);
          });
      });
      transport.on("connectionstatechange", (state) => {
        if (
          !this.#closed &&
          !this.#renewingIce.has(transport) &&
          (state === "failed" || state === "disconnected")
        ) {
          onFailure(
            new RoomError("ICE_CONNECTION_LOST", "The media transport lost connectivity", true),
          );
        }
      });
    }
  }

  suspend(): void {
    this.#suspended = true;
  }

  async resume(tracks: readonly Track[], participantId: string): Promise<void> {
    this.#assertOpen();
    this.#suspended = false;
    const local = tracks.filter(
      (track) => track.participantId === participantId && track.state !== "unpublished",
    );
    const activeIds = new Set([...this.#publications].map((publication) => publication.info.id));
    if ([...activeIds].some((id) => !local.some((track) => track.id === id)))
      throw new RoomError(
        "RTC_STATE_CHANGED",
        "The media runtime no longer owns the local publications",
      );
    for (const track of local)
      if (!activeIds.has(track.id)) this.#deferredTracks.set(track.id, track);
    for (const id of [...this.#deferredSubscriptions]) {
      this.#deferredSubscriptions.delete(id);
      await this.#closeSubscription(id);
    }
    for (const [id, info] of [...this.#deferredTracks]) {
      this.#deferredTracks.delete(id);
      if (local.some((track) => track.id === id)) await this.#unpublish(info);
    }
  }

  recoverIce(): Promise<void> {
    return this.#queueIce();
  }

  renewIceServers(iceServers: readonly RTCIceServer[]): Promise<void> {
    return this.#queueIce(iceServers);
  }

  #queueIce(iceServers?: readonly RTCIceServer[]): Promise<void> {
    const operation = this.#iceOperation
      .catch(() => undefined)
      .then(() => this.#restartIce(iceServers));
    this.#iceOperation = operation;
    return operation;
  }

  async #restartIce(iceServers?: readonly RTCIceServer[]): Promise<void> {
    this.#assertOpen();
    const signaling = this.#signaling;
    const scope = this.#scope;
    if (!signaling || !scope)
      throw new RoomError("NOT_CONNECTED", "The media transports are unavailable");
    for (const transport of this.#transports) {
      this.#renewingIce.add(transport);
      try {
        if (iceServers)
          await transport.updateIceServers({ iceServers: structuredClone([...iceServers]) });
        this.#assertOpen();
        const unused = transport.connectionState === "new";
        const response = await signaling.request(
          "rtc.ice.restart",
          { ...scope, transportId: transport.id },
          "rtc.ice.restarted",
        );
        this.#checkScope(response, scope);
        if (response.transportId !== transport.id)
          throw new RoomError(
            "PROTOCOL_ERROR",
            "The renewed ICE transport does not match the request",
          );
        this.#assertOpen();
        await transport.restartIce({
          iceParameters: response.iceParameters as unknown as types.IceParameters,
        });
        this.#assertOpen();
        if (!unused) await this.#waitForIce(transport);
      } finally {
        this.#renewingIce.delete(transport);
      }
    }
  }

  #waitForIce(transport: types.Transport): Promise<void> {
    if (transport.connectionState === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: RoomError): void => {
        clearTimeout(timer);
        transport.off("connectionstatechange", changed);
        transport.observer.off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const changed = (state: types.ConnectionState): void => {
        if (state === "connected") finish();
        else if (state === "failed" || state === "closed")
          finish(
            new RoomError(
              "ICE_RECOVERY_FAILED",
              "The renewed ICE transport could not connect",
              true,
            ),
          );
      };
      const closed = (): void => {
        finish(
          new RoomError("NOT_CONNECTED", "The media transport closed during credential renewal"),
        );
      };
      const timer = setTimeout(() => {
        finish(new RoomError("ICE_RECOVERY_FAILED", "The renewed ICE transport timed out", true));
      }, this.#timeoutMs);
      transport.on("connectionstatechange", changed);
      transport.observer.on("close", closed);
      if (transport.closed) closed();
    });
  }

  async setSubscriptionQuality(
    subscriptionId: string,
    quality: VideoQualityPreference,
  ): Promise<void> {
    this.#assertOpen();
    const scope = this.#scope;
    if (!this.#signaling || !scope)
      throw new RoomError("NOT_CONNECTED", "Media signaling is unavailable");
    const accepted = await this.#signaling.request(
      "rtc.subscription.quality",
      { ...scope, subscriptionId, quality },
      "rtc.subscription.quality.accepted",
    );
    this.#checkScope(accepted, scope);
    if (accepted.subscriptionId !== subscriptionId || accepted.quality !== quality)
      throw new RoomError("PROTOCOL_ERROR", "The quality response does not match the subscription");
  }

  async consume(
    info: Track,
    onClosed: (error: RoomError) => void,
    quality?: VideoQualityPreference,
  ): Promise<RemoteSubscription> {
    this.#assertOpen();
    const transport = this.#receiveTransport;
    const device = this.#device;
    const signaling = this.#signaling;
    const scope = this.#scope;
    if (!transport || !device || !signaling || !scope)
      throw new RoomError("NOT_CONNECTED", "The receive transport is unavailable");
    if (info.type === "data")
      throw new RoomError(
        "MEDIA_SUBSCRIBE_FAILED",
        "Data tracks cannot be received as browser media",
      );
    let id: string | undefined;
    let consumer: types.Consumer | undefined;
    let subscription: RemoteSubscription | undefined;
    const pending: PendingSubscription = { cancelled: false };
    try {
      const response = await signaling.request(
        "rtc.track.subscribe",
        {
          ...scope,
          transportId: transport.id,
          trackId: info.id,
          rtpCapabilities: device.recvRtpCapabilities,
          ...(quality ? { quality } : {}),
        },
        "rtc.track.subscribe.accepted",
      );
      this.#checkScope(response, scope);
      id = response.subscriptionId;
      if (response.trackId !== info.id || response.trackType !== info.type)
        throw new RoomError("PROTOCOL_ERROR", "The subscription does not match the remote track");
      this.#pendingSubscriptions.set(id, pending);
      this.#assertOpen();
      if (this.#closedSubscriptions.has(id))
        throw new RoomError(
          "MEDIA_SUBSCRIBE_FAILED",
          "The server closed the remote subscription during setup",
        );
      consumer = await this.#createConsumer(
        transport,
        {
          id,
          producerId: info.id,
          kind: info.type === "audio" || info.type === "screen_audio" ? "audio" : "video",
          rtpParameters: response.rtpParameters as unknown as types.RtpParameters,
          streamId: info.sessionId,
        },
        pending,
      );
      this.#assertOpen();
      const receiver = consumer;
      const subscriptionId = id;
      let disposed = false;
      let closing: Promise<void> | undefined;
      subscription = {
        id,
        track: receiver.track,
        setPaused: (paused) => {
          if (!disposed) {
            if (paused) receiver.pause();
            else receiver.resume();
          }
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          this.#subscriptions.delete(subscriptionId);
          receiver.close();
        },
        close: () => {
          if (closing) return closing;
          subscription?.dispose();
          closing = this.#closeSubscription(subscriptionId);
          return closing;
        },
      };
      const active = subscription;
      this.#subscriptions.set(id, { subscription: active, onClosed });
      const lost = (): void => {
        if (disposed || this.#closed) return;
        active.dispose();
        onClosed(
          new RoomError(
            "MEDIA_SUBSCRIBE_FAILED",
            "The remote media track stopped unexpectedly",
            true,
          ),
        );
        void this.#closeSubscription(subscriptionId).catch(() => undefined);
      };
      receiver.on("trackended", lost);
      receiver.on("transportclose", lost);
      const resumed = await signaling.request(
        "rtc.subscription.resume",
        { ...scope, subscriptionId: id },
        "rtc.subscription.resumed",
      );
      this.#checkScope(resumed, scope);
      if (resumed.subscriptionId !== id)
        throw new RoomError(
          "PROTOCOL_ERROR",
          "The resumed subscription does not match the remote track",
        );
      this.#assertOpen();
      if (pending.cancelled || receiver.closed || receiver.track.readyState === "ended")
        throw new RoomError("MEDIA_SUBSCRIBE_FAILED", "The remote subscription ended during setup");
      active.setPaused(info.state === "paused");
      return active;
    } catch (error) {
      pending.cancelled = true;
      subscription?.dispose();
      consumer?.close();
      if (id) await this.#closeSubscription(id).catch(() => undefined);
      const failure =
        error instanceof RoomError
          ? error
          : new RoomError("MEDIA_SUBSCRIBE_FAILED", "The remote track could not be received");
      if (failure.code === "PROTOCOL_ERROR" || (failure.code === "REQUEST_TIMEOUT" && !id))
        this.#reportCleanupFailure(failure);
      throw failure;
    } finally {
      if (id) this.#pendingSubscriptions.delete(id);
    }
  }

  subscriptionClosed(id: string, reason: string): void {
    this.#closedSubscriptions.add(id);
    if (this.#closedSubscriptions.size > 4096) {
      const oldest = this.#closedSubscriptions.values().next().value;
      if (oldest) this.#closedSubscriptions.delete(oldest);
    }
    const pending = this.#pendingSubscriptions.get(id);
    if (pending) {
      pending.cancelled = true;
      pending.cancel?.();
    }
    const active = this.#subscriptions.get(id);
    if (active) {
      active.subscription.dispose();
      active.onClosed(
        new RoomError(
          reason === "track_unpublished" || reason === "owner_left" || reason === "cancelled"
            ? "MEDIA_OPERATION_CANCELLED"
            : "MEDIA_SUBSCRIBE_FAILED",
          `The server closed the remote subscription: ${reason}`,
          reason === "runtime_reset" || reason === "negotiation_timeout",
        ),
      );
    }
  }

  #createConsumer(
    transport: types.Transport,
    options: types.ConsumerOptions,
    pending: PendingSubscription,
  ): Promise<types.Consumer> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RoomError("MEDIA_SUBSCRIBE_FAILED", "Remote media setup was cancelled"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new RoomError("REQUEST_TIMEOUT", "Remote media setup timed out", true));
      }, this.#timeoutMs);
      pending.cancel = cancel;
      if (pending.cancelled || this.#closed) {
        cancel();
        return;
      }
      void transport.consume(options).then(
        (consumer) => {
          if (settled || pending.cancelled || this.#closed) {
            consumer.close();
            cancel();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(consumer);
        },
        (error: unknown) => {
          settled = true;
          clearTimeout(timer);
          reject(
            error instanceof Error
              ? error
              : new RoomError("MEDIA_SUBSCRIBE_FAILED", "The receive transport rejected the track"),
          );
        },
      );
    });
  }

  async #closeSubscription(id: string): Promise<void> {
    const scope = this.#scope;
    const signaling = this.#signaling;
    if (this.#closed || this.#closedSubscriptions.has(id) || !scope || !signaling) return;
    if (this.#suspended) {
      this.#deferredSubscriptions.add(id);
      return;
    }
    try {
      const response = await signaling.request(
        "rtc.subscription.close",
        { ...scope, subscriptionId: id },
        "rtc.subscription.close.accepted",
      );
      this.#checkScope(response, scope);
      if (response.subscriptionId !== id)
        throw new RoomError(
          "PROTOCOL_ERROR",
          "The closed subscription does not match the remote track",
        );
    } catch (error) {
      if (this.#closedSubscriptions.has(id)) return;
      if (this.#isSuspended()) {
        this.#deferredSubscriptions.add(id);
        return;
      }
      if (error instanceof RoomError && error.code === "RESOURCE_NOT_FOUND") return;
      const failure =
        error instanceof RoomError
          ? error
          : new RoomError("MEDIA_SUBSCRIBE_FAILED", "The remote subscription could not be removed");
      this.#reportCleanupFailure(failure);
      throw failure;
    }
  }

  async publish(track: MediaStreamTrack, trackType: RoomLocalTrackType): Promise<LocalPublication> {
    this.#assertOpen();
    const transport = this.#sendTransport;
    if (!transport) throw new RoomError("NOT_CONNECTED", "The room media transport is unavailable");
    const height = track.getSettings().height;
    const data: PublicationData = { trackType, ...(height ? { sourceHeight: height } : {}) };
    let producer: types.Producer | undefined;
    try {
      producer = await transport.produce({
        track,
        stopTracks: false,
        disableTrackOnPause: true,
        zeroRtpOnPause: true,
        appData: data,
        ...(track.kind === "video"
          ? { encodings: simulcastEncodings.map((encoding) => ({ ...encoding })) }
          : {}),
      });
      this.#assertOpen();
      const info = data.publication;
      if (!info) throw new RoomError("PROTOCOL_ERROR", "The local publication is unavailable");
      const sender = producer;
      let disposed = false;
      let closing: Promise<void> | undefined;
      const assertActive = (): void => {
        if (disposed || this.#closed || sender.closed)
          throw new RoomError("MEDIA_NOT_ENABLED", "The local publication is no longer active");
      };
      const publication: LocalPublication = {
        info,
        get muted() {
          return sender.paused;
        },
        replaceTrack: async (replacement) => {
          assertActive();
          await sender.replaceTrack({ track: replacement });
          assertActive();
        },
        mute: () => {
          assertActive();
          sender.pause();
        },
        unmute: () => {
          assertActive();
          sender.resume();
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          sender.close();
          this.#publications.delete(publication);
        },
        close: () => {
          if (closing) return closing;
          publication.dispose();
          closing = this.#closed ? Promise.resolve() : this.#unpublish(info);
          return closing;
        },
      };
      this.#publications.add(publication);
      return publication;
    } catch (error) {
      producer?.close();
      if (data.publication && !this.#closed)
        await this.#unpublish(data.publication).catch(() => undefined);
      throw error instanceof RoomError
        ? error
        : new RoomError("MEDIA_PUBLISH_FAILED", "The local track could not be published");
    }
  }

  async #unpublish(info: Track): Promise<void> {
    const scope = this.#scope;
    const signaling = this.#signaling;
    if (!scope || !signaling || this.#closed) return;
    if (this.#suspended) {
      this.#deferredTracks.set(info.id, info);
      return;
    }
    try {
      const response = await signaling.request(
        "rtc.track.control",
        { ...scope, trackId: info.id, action: "unpublish" },
        "rtc.track.control.accepted",
      );
      this.#checkScope(response, scope);
      if (response.track.id !== info.id || response.track.state !== "unpublished")
        throw new RoomError(
          "PROTOCOL_ERROR",
          "The removed publication does not match the local track",
        );
    } catch (error) {
      if (this.#isSuspended()) {
        this.#deferredTracks.set(info.id, info);
        return;
      }
      if (error instanceof RoomError && error.code === "RESOURCE_NOT_FOUND") return;
      const failure =
        error instanceof RoomError
          ? error
          : new RoomError("MEDIA_PUBLISH_FAILED", "The local publication could not be removed");
      this.#reportCleanupFailure(failure);
      throw failure;
    }
  }

  #reportCleanupFailure(error: RoomError): void {
    if (!this.#closed) this.#onFailure?.(error);
  }

  #isSuspended(): boolean {
    return this.#suspended;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#deferredTracks.clear();
    this.#deferredSubscriptions.clear();
    for (const pending of this.#pendingSubscriptions.values()) {
      pending.cancelled = true;
      pending.cancel?.();
    }
    this.#pendingSubscriptions.clear();
    for (const active of this.#subscriptions.values()) active.subscription.dispose();
    this.#subscriptions.clear();
    this.#closedSubscriptions.clear();
    for (const publication of this.#publications) publication.dispose();
    this.#publications.clear();
    for (const transport of this.#transports) transport.close();
    this.#transports.length = 0;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RoomError("JOIN_CANCELLED", "Room setup was cancelled");
  }

  #checkScope(response: RtcSessionScope, scope: RtcSessionScope): void {
    if (response.roomId !== scope.roomId || response.sessionId !== scope.sessionId) {
      throw new RoomError("PROTOCOL_ERROR", "The media response does not match the joined session");
    }
  }
}
