import { DynamicStreamingExports } from "./dynamic-streaming-export.js";
import type { Consumer, PlainTransport, Producer, Router } from "mediasoup/types";

export interface StreamingExportRequest {
  dynamic?: boolean;
  exportId: string;
  roomId: string;
  receiverIp: string;
  ports: number[];
  videoTrackIds: string[];
  audioTrackIds: string[];
  audioOnly: boolean;
  layout: "single" | "grid";
}
export interface StreamingExportTrack {
  participantId?: string;
  id: string;
  kind: "audio" | "video";
  trackType: string;
  codec: string;
  sdp: string;
}
interface ExportState {
  tracks: StreamingExportTrack[];
  consumers: Consumer[];
  transports: PlainTransport[];
  timer: ReturnType<typeof setTimeout>;
  lost: boolean;
  roomId: string;
  ready: boolean;
  detach: () => void;
}

// No participant is added to the room. Export consumers have their own bounded lease.
export class StreamingExports {
  readonly #dynamic=new DynamicStreamingExports();
  readonly #exports = new Map<string, ExportState>();
  async create(request: StreamingExportRequest, router: Router, producers: Map<string, Producer>) {
    if(request.dynamic)return this.#dynamic.create(request,router,producers);
    const existing = this.#exports.get(request.exportId);
    if (existing) {
      if (!existing.ready || existing.lost) throw new Error("STREAM_EXPORT_NOT_READY");
      return { tracks: existing.tracks };
    }
    if (
      this.#exports.size >= 64 ||
      [...this.#exports.values()].filter((v) => v.roomId === request.roomId).length >= 2
    )
      throw new Error("STREAM_EXPORT_CAPACITY");
    const available = [...producers.values()].filter((p) => !p.closed);
    const choose = (kind: "audio" | "video", ids: string[], limit: number) => {
      const selected = ids.length
        ? ids.map((id) => producers.get(id))
        : available
            .filter((p) => p.kind === kind)
            .sort(
              (a, b) =>
                Number(b.appData.trackType === "screen_video") -
                  Number(a.appData.trackType === "screen_video") || a.id.localeCompare(b.id),
            )
            .slice(0, limit);
      if (selected.some((p) => p?.kind !== kind)) throw new Error("STREAM_TRACK_NOT_IN_ROOM");
      return selected as Producer[];
    };
    const selected = [
      ...(request.audioOnly
        ? []
        : choose("video", request.videoTrackIds, request.layout === "single" ? 1 : 4)),
      ...choose("audio", request.audioTrackIds, 8),
    ];
    if (selected.length === 0 || selected.length > request.ports.length)
      throw new Error("STREAM_TRACKS_UNAVAILABLE");
    const state: ExportState = {
      tracks: [],
      consumers: [],
      transports: [],
      roomId: request.roomId,
      ready: false,
      detach: () => {
        router.observer.removeListener("close", close);
      },
      lost: false,
      timer: setTimeout(() => {
        this.close(request.exportId);
      }, 15000),
    };
    state.timer.unref();
    this.#exports.set(request.exportId, state);
    const close = () => {
      this.close(request.exportId);
    };
    router.observer.once("close", close);
    try {
      for (const [index, producer] of selected.entries()) {
        const codec = producer.rtpParameters.codecs.find(
          (c) => !c.mimeType.toLowerCase().endsWith("/rtx"),
        );
        if (
          !codec ||
          !["audio/opus", "video/h264", "video/vp8"].includes(codec.mimeType.toLowerCase())
        )
          throw new Error("STREAM_CODEC_UNSUPPORTED");
        const codecs = required(
          router.rtpCapabilities.codecs?.filter(
            (c) => c.mimeType.toLowerCase() === codec.mimeType.toLowerCase(),
          ),
        );
        const transport = await router.createPlainTransport({
          listenInfo: { protocol: "udp", ip: "0.0.0.0" },
          rtcpMux: false,
          comedia: false,
        });
        state.transports.push(transport);
        if (this.#exports.get(request.exportId) !== state) throw new Error("STREAM_EXPORT_EXPIRED");
        const port = required(request.ports[index]);
        await transport.connect({ ip: request.receiverIp, port, rtcpPort: port + 1 });
        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: { codecs, headerExtensions: [] },
          paused: true,
        });
        state.consumers.push(consumer);
        if (this.#exports.get(request.exportId) !== state) throw new Error("STREAM_EXPORT_EXPIRED");
        consumer.on("producerclose", () => {
          state.lost = true;
        });
        if (producer.kind === "video" && producer.type === "simulcast")
          await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
        const out = required(consumer.rtpParameters.codecs[0]);
        const fmtp = Object.entries(out.parameters ?? {})
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(";");
        const sdp =
          [
            "v=0",
            "o=- 0 0 IN IP4 127.0.0.1",
            "s=RelayRTC streaming export",
            `c=IN IP4 ${request.receiverIp}`,
            "t=0 0",
            `m=${producer.kind} ${String(port)} RTP/AVP ${String(out.payloadType)}`,
            `a=rtpmap:${String(out.payloadType)} ${String(out.mimeType.split("/")[1])}/${String(out.clockRate)}${out.channels ? `/${String(out.channels)}` : ""}`,
            `a=rtcp:${String(port + 1)}`,
            "a=recvonly",
            ...(fmtp ? [`a=fmtp:${String(out.payloadType)} ${fmtp}`] : []),
          ].join("\r\n") + "\r\n";
        state.tracks.push({
          id: producer.id,
          kind: producer.kind,
          trackType: String(producer.appData.trackType),
          codec: out.mimeType.toLowerCase().split("/")[1] ?? "unknown",
          sdp,
        });
      }
      if (this.#exports.get(request.exportId) !== state) throw new Error("STREAM_EXPORT_EXPIRED");
      state.ready = true;
      return { tracks: state.tracks };
    } catch (error) {
      close();
      for (const transport of state.transports) transport.close();
      throw error;
    } finally {
      if (!this.#exports.has(request.exportId)) router.observer.removeListener("close", close);
    }
  }
  async control(exportId: string, action: "resume" | "renew" | "close") {
    if(this.#dynamic.has(exportId))return this.#dynamic.control(exportId,action);
    if (action === "close") {
      this.close(exportId);
      return { bytes: 0 };
    }
    const state = this.#exports.get(exportId);
    if (!state || state.lost || !state.ready) throw new Error("STREAM_EXPORT_EXPIRED");
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.close(exportId);
    }, 15000);
    state.timer.unref();
    if (action === "resume")
      for (const consumer of state.consumers) {
        await consumer.resume();
        if (consumer.kind === "video") await consumer.requestKeyFrame();
      }
    let bytes = 0;
    for (const consumer of state.consumers)
      for (const stats of await consumer.getStats())
        if (stats.type === "outbound-rtp") bytes += stats.byteCount;
    return { bytes };
  }
  close(exportId: string) {
    this.#dynamic.close(exportId);
    const state = this.#exports.get(exportId);
    if (!state) return;
    clearTimeout(state.timer);
    this.#exports.delete(exportId);
    state.detach();
    for (const transport of state.transports) transport.close();
  }
  closeAll() {
    this.#dynamic.closeAll();
    for (const id of this.#exports.keys()) this.close(id);
  }
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
