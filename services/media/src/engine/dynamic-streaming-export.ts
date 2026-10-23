import type { Consumer, PlainTransport, Producer, Router } from "mediasoup/types";
import type { StreamingExportRequest, StreamingExportTrack } from "./streaming-export.js";
interface Entry {
  consumer: Consumer;
  transport: PlainTransport;
  track: StreamingExportTrack;
  slot: number;
  bytes: number;
  lastKeyFrameAt: number;
}
interface State {
  roomId: string;
  entries: Map<string, Entry>;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
  bytes: number;
  detach: () => void;
}
/** Stage exports reconcile RTP subscriptions while healthy tracks keep their ports and consumers. */
export class DynamicStreamingExports {
  private states = new Map<string, State>();
  has(id: string) {
    return this.states.has(id);
  }
  private pending = new Map<string, Promise<{ tracks: StreamingExportTrack[] }>>();
  create(request: StreamingExportRequest, router: Router, producers: Map<string, Producer>) {
    const pending = this.pending.get(request.exportId);
    if (pending) return pending;
    const task = this.reconcile(request, router, producers).finally(() => {
      this.pending.delete(request.exportId);
    });
    this.pending.set(request.exportId, task);
    return task;
  }
  private async reconcile(
    request: StreamingExportRequest,
    router: Router,
    producers: Map<string, Producer>,
  ) {
    let state = this.states.get(request.exportId);
    if (!state) {
      if (this.states.size >= 32) throw new Error("STREAM_EXPORT_CAPACITY");
      const close = () => {
        this.close(request.exportId);
      };
      state = {
        roomId: request.roomId,
        entries: new Map(),
        started: false,
        bytes: 0,
        timer: setTimeout(close, 15000),
        detach: () => router.observer.removeListener("close", close),
      };
      state.timer.unref();
      router.observer.once("close", close);
      this.states.set(request.exportId, state);
    }
    const current = state;
    if (current.roomId !== request.roomId) throw new Error("STREAM_EXPORT_SCOPE_CONFLICT");
    const available = [...producers.values()]
      .filter((p) => {
        const selected = p.kind === "video" ? request.videoTrackIds : request.audioTrackIds;
        return !p.closed && !p.paused && (!selected.length || selected.includes(p.id));
      })
      .sort(
        (a, b) =>
          String(a.appData.participantId).localeCompare(String(b.appData.participantId)) ||
          Number(b.appData.trackType === "screen_video") -
            Number(a.appData.trackType === "screen_video") ||
          a.id.localeCompare(b.id),
      );
    let selectedVideos = 0;
    const owners = new Set<string>(),
      selected = available.filter((p) => {
        if (p.kind !== "video" || request.audioOnly) return false;
        const owner = String(p.appData.participantId);
        if ((!request.videoTrackIds.length && owners.has(owner)) || selectedVideos >= 4)
          return false;
        owners.add(owner);
        selectedVideos++;
        return true;
      });
    selected.push(...available.filter((p) => p.kind === "audio").slice(0, 8));
    const ids = new Set(selected.map((p) => p.id));
    for (const [id, entry] of current.entries)
      if (!ids.has(id) || entry.consumer.closed) {
        current.bytes += entry.bytes;
        entry.transport.close();
        current.entries.delete(id);
      }
    try {
      for (const producer of selected) {
        if (current.entries.has(producer.id)) continue;
        const used = new Set([...current.entries.values()].map((e) => e.slot)),
          slot = request.ports.findIndex((_p, i) => !used.has(i));
        if (slot < 0) break;
        const port = request.ports[slot];
        if (port === undefined) continue;
        const codec = producer.rtpParameters.codecs.find(
          (c) => !c.mimeType.toLowerCase().endsWith("/rtx"),
        );
        if (
          !codec ||
          !["audio/opus", "video/h264", "video/vp8"].includes(codec.mimeType.toLowerCase())
        )
          continue;
        const transport = await router.createPlainTransport({
          listenInfo: { protocol: "udp", ip: "0.0.0.0" },
          rtcpMux: false,
          comedia: false,
        });
        try {
          await transport.connect({ ip: request.receiverIp, port, rtcpPort: port + 1 });
          const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: {
              codecs:
                router.rtpCapabilities.codecs?.filter(
                  (c) => c.mimeType.toLowerCase() === codec.mimeType.toLowerCase(),
                ) ?? [],
              headerExtensions: [],
            },
            paused: true,
          });
          if (this.states.get(request.exportId) !== current) {
            transport.close();
            throw new Error("STREAM_EXPORT_EXPIRED");
          }
          // This consumer feeds the broadcast compositor, whose output can be
          // full resolution. Layer zero permanently degrades the program even
          // when the publisher and the internal network have ample capacity.
          if (producer.kind === "video" && producer.type === "simulcast")
            await consumer.setPreferredLayers({
              spatialLayer: Math.max(0, (producer.rtpParameters.encodings?.length ?? 1) - 1),
            });
          const out = consumer.rtpParameters.codecs[0];
          if (!out) throw new Error("STREAM_CODEC_UNSUPPORTED");
          if (
            Object.entries(out.parameters ?? {}).some(
              ([key, value]) =>
                !/^[A-Za-z0-9_.-]{1,64}$/u.test(key) ||
                String(value).length > 512 ||
                Array.from(String(value)).some(
                  (c) => (c.codePointAt(0) ?? 0) < 32 || c.codePointAt(0) === 127,
                ),
            )
          )
            throw new Error("STREAM_CODEC_PARAMETERS_UNSAFE");
          const fmtp = Object.entries(out.parameters ?? {})
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(";");
          const sdp =
            [
              "v=0",
              "o=- 0 0 IN IP4 127.0.0.1",
              "s=RelayRTC stage export",
              `c=IN IP4 ${request.receiverIp}`,
              "t=0 0",
              `m=${producer.kind} ${String(port)} RTP/AVP ${String(out.payloadType)}`,
              `a=rtpmap:${String(out.payloadType)} ${String(out.mimeType.split("/")[1])}/${String(out.clockRate)}${out.channels ? `/${String(out.channels)}` : ""}`,
              `a=rtcp:${String(port + 1)}`,
              "a=recvonly",
              ...(fmtp ? [`a=fmtp:${String(out.payloadType)} ${fmtp}`] : []),
            ].join("\r\n") + "\r\n";
          current.entries.set(producer.id, {
            consumer,
            transport,
            slot,
            bytes: 0,
            lastKeyFrameAt: 0,
            track: {
              id: producer.id,
              participantId: String(producer.appData.participantId),
              kind: producer.kind,
              trackType: String(producer.appData.trackType),
              codec: out.mimeType.toLowerCase().split("/")[1] ?? "unknown",
              sdp,
            },
          });
        } catch (error) {
          transport.close();
          if (this.states.get(request.exportId) !== current) throw error;
          // A bad or disappearing guest track must not tear down healthy stage exports.
          continue;
        }
      }
      return {
        tracks: [...current.entries.values()].filter((e) => !e.consumer.closed).map((e) => e.track),
      };
    } catch (error) {
      this.close(request.exportId);
      throw error;
    }
  }
  async control(id: string, action: "resume" | "renew" | "close") {
    if (action === "close") {
      this.close(id);
      return { bytes: 0 };
    }
    const state = this.states.get(id);
    if (!state) throw new Error("STREAM_EXPORT_EXPIRED");
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.close(id);
    }, 15000);
    state.timer.unref();
    if (action === "resume") {
      state.started = true;
      for (const e of state.entries.values())
        if (!e.consumer.closed) {
          const wasPaused = e.consumer.paused;
          await e.consumer.resume();
          // A decoder may bind its RTP socket after the initial resume, or be
          // replaced while this consumer stays alive. Explicit resume retries
          // must be able to request another keyframe without recreating media.
          const now = Date.now();
          if (e.consumer.kind === "video" && (wasPaused || now - e.lastKeyFrameAt >= 1000)) {
            e.lastKeyFrameAt = now;
            await e.consumer.requestKeyFrame();
          }
        }
    }
    let bytes = state.bytes;
    for (const e of state.entries.values()) {
      if (!e.consumer.closed) {
        const stats = await e.consumer.getStats();
        e.bytes = Math.max(
          e.bytes,
          stats.reduce((n, s) => n + (s.type === "outbound-rtp" ? s.byteCount : 0), 0),
        );
      }
      bytes += e.bytes;
    }
    return { bytes };
  }
  closeAll() {
    for (const id of this.states.keys()) this.close(id);
  }
  close(id: string) {
    const state = this.states.get(id);
    if (!state) return;
    this.states.delete(id);
    clearTimeout(state.timer);
    state.detach();
    for (const e of state.entries.values()) e.transport.close();
  }
}
