import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { mixerSceneSchema } from "@relayrtc/validation";
import { decodeMixerPng } from "@relayrtc/protocol/mixer-png";
import type { MixerScene, StreamProfile } from "@relayrtc/types";
import {
  encoderArguments,
  encoderDiagnostic,
  stopEncoder,
  trackEncoderProgress,
  type EncoderInput,
} from "./encoder.js";
import { roomDecoderArguments } from "./room-decoder.js";
import { dueMixerFrames } from "./mixer-clock.js";
import { blitYuv, solidYuv } from "./mixer-yuv.js";
import { solid, blit, mixAudio, sceneLayers, type Raster } from "./mixer-canvas.js";

const configSchema = z.object({
  mixer: z
    .object({
      id: z.string(),
      revision: z.number().int(),
      sceneId: z.string(),
      scene: mixerSceneSchema,
      primaryUrl: z.string(),
      sources: z
        .array(z.object({ id: z.string(), streamId: z.string(), audioOnly: z.boolean() }))
        .max(4),
    })
    .nullable(),
});
interface Decoder {
  child: ChildProcess | undefined;
  audioChild: ChildProcess | undefined;
  width: number;
  height: number;
  frame: Raster | null;
  frameAt: number;
  audio: Buffer;
  audioAt: number;
  sourceId: string;
  inputKey: string;
  videoKey: string;
  audioKey: string;
  videoStartedAt: number;
  videoExpected: boolean;
  audioExpected: boolean;
  retryAt: number;
}
interface PreparedScene {
  revision: number;
  sceneId: string;
  scene: MixerScene;
  background: Raster;
  images: Map<string, Raster>;
}
export interface MixerEngineOptions {
  nativeRoomVideo?: boolean;
  primary: EncoderInput;
  inputForSource?: (sourceId: string) => EncoderInput | undefined;
  onSourcesReady?: (needsResume: boolean) => Promise<unknown>;
  profile: StreamProfile;
  programUrl: string;
  maxDurationSeconds: number;
  directory: string;
  binary: string;
  origin: URL;
  signal: AbortSignal;
  token: () => string;
  control: () => Promise<unknown>;
  onFatal: () => void;
}
export async function startMixerEngine(options: MixerEngineOptions) {
  const pixelFormat = options.nativeRoomVideo ? "yuv420p" : "rgba";
  const background = (color: string) =>
    options.nativeRoomVideo
      ? solidYuv(color, options.profile.width, options.profile.height)
      : solid(color, options.profile.width, options.profile.height);
  const MIXER_FPS = options.profile.fps,
    PCM_BYTES = Math.round(48000 / MIXER_FPS) * 4,
    width = options.profile.width,
    height = options.profile.height;
  const { signal, binary } = options,
    decoders = new Map<string, Decoder>(),
    children = new Set<ChildProcess>();
  let current: z.infer<typeof configSchema>["mixer"] = null,
    prepared: PreparedScene | null = null,
    displayed: PreparedScene | null = null;
  let appliedVersion = 0,
    appliedSceneId: string | null = null,
    frames = 0,
    inputSeconds = 0,
    duck = 1,
    overloadedUntil = 0,
    closed = false,
    preparing = false,
    preparationFailed = false;
  const abort = new AbortController(),
    jobSignal = AbortSignal.any([signal, abort.signal]);
  const isAborted = () => jobSignal.aborted;
  const cleanEnv = { PATH: process.env.PATH };
  const proxy = createServer((request, response) => {
    void (async () => {
      const match = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.(?:m3u8|mp4|m4s|ts))$/u.exec(
        request.url ?? "",
      );
      const sourceId = match?.[1],
        name = match?.[2];
      if (!sourceId || !name || !decoders.has(sourceId)) throw new Error("MIXER_MEDIA_DENIED");
      const body = await fetchBody(
        `/internal/v1/streaming/mixer-media/${sourceId}/${name}`,
        16777216,
      );
      response.writeHead(200, {
        "content-type": name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
        "content-length": body.length,
      });
      response.end(body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("MIXER_BRIDGE_FAILED");
  const port = address.port,
    guard = process.env.STREAMING_EGRESS_GUARD;
  if (process.platform !== "linux" || !guard || !existsSync(guard)) {
    proxy.close();
    throw new Error("MIXER_PROCESS_GUARD_REQUIRED");
  }
  const guardedEnv = {
    ...cleanEnv,
    LD_PRELOAD: guard,
    RELAYRTC_EGRESS_LOOPBACK_PORTS: `${String(port)},${String(port)}`,
  };
  async function fetchBody(path: string, limit: number) {
    const response = await fetch(new URL(path, options.origin), {
      headers: { authorization: `Bearer ${options.token()}` },
      redirect: "error",
      signal: AbortSignal.any([jobSignal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("MIXER_MEDIA_UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("MIXER_MEDIA_UNAVAILABLE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const piece = await reader.read();
        if (piece.done) break;
        size += piece.value.length;
        if (size > limit) throw new Error("MIXER_MEDIA_LIMIT");
        chunks.push(piece.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  function track(child: ChildProcess) {
    children.add(child);
    child.once("error", () => undefined);
    child.once("close", () => {
      children.delete(child);
    });
    return child;
  }
  function bindVideo(d: Decoder, video: Readable, live: boolean) {
    const frameBytes = d.width * d.height * (options.nativeRoomVideo ? 1.5 : 4);
    let assembling: Buffer = Buffer.allocUnsafe(frameBytes),
      frameOffset = 0;
    video.on("data", (data: Buffer) => {
      let offset = 0;
      while (offset < data.length) {
        const size = Math.min(frameBytes - frameOffset, data.length - offset);
        data.copy(assembling, frameOffset, offset, offset + size);
        frameOffset += size;
        offset += size;
        if (frameOffset === frameBytes) {
          const previous = d.frame?.pixels;
          d.frame = { width: d.width, height: d.height, opaque: true, pixels: assembling };
          d.frameAt = Date.now();
          assembling = previous?.length === frameBytes ? previous : Buffer.allocUnsafe(frameBytes);
          frameOffset = 0;
          if (!live) video.pause();
        }
      }
    });
  }
  function bindAudio(d: Decoder, audio: Readable, live: boolean) {
    audio.on("data", (data: Buffer) => {
      const combined = Buffer.concat([d.audio, data]);
      d.audio = Buffer.from(
        combined.subarray(Math.max(0, Math.ceil((combined.length - PCM_BYTES * 3) / 4) * 4)),
      );
      d.audioAt = Date.now();
      if (!live && d.audio.length >= PCM_BYTES * 2) audio.pause();
    });
  }
  function startRoomDecoder(d: Decoder, input: EncoderInput) {
    if (Date.now() < d.retryAt || jobSignal.aborted) return false;
    let started = false;
    for (const kind of ["video", "audio"] as const) {
      const medium = input.mediaInputs?.[kind];
      const key = kind === "video" ? "child" : "audioChild";
      if (!medium || d[key] || (kind === "video" && options.profile.audioOnly)) continue;
      const child = track(
        spawn(
          binary,
          roomDecoderArguments(medium, kind, d.width, d.height, MIXER_FPS, pixelFormat),
          {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            signal: jobSignal,
            env: cleanEnv,
          },
        ),
      );
      d[key] = child;
      if (kind === "video") d.videoStartedAt = Date.now();
      let diagnostic = "";
      child.stderr?.on("data", (data: Buffer) => {
        diagnostic += data.toString().slice(0, Math.max(0, 8192 - diagnostic.length));
      });
      if (child.stdout) {
        if (kind === "video") bindVideo(d, child.stdout, true);
        else bindAudio(d, child.stdout, true);
      }
      child.once("close", (code) => {
        if (d[key] !== child) return;
        d[key] = undefined;
        d.retryAt = Date.now() + 2000;
        if (!jobSignal.aborted && code !== 0)
          console.warn(
            JSON.stringify({
              event: "mixer.decoder.failed",
              sourceId: d.sourceId,
              kind,
              code,
              diagnostic: encoderDiagnostic(diagnostic, medium.args),
            }),
          );
      });
      started = true;
    }
    return started;
  }
  function startDecoder(
    d: Decoder,
    source: NonNullable<z.infer<typeof configSchema>["mixer"]>["sources"][number],
  ) {
    const custom = options.inputForSource?.(source.id);
    if (custom?.mediaInputs) return startRoomDecoder(d, custom);
    if (d.child || Date.now() < d.retryAt || jobSignal.aborted) return false;
    let input = custom ?? options.primary;
    if (!custom && source.id !== "primary")
      input = {
        args: [
          "-protocol_whitelist",
          "file,http,tcp",
          "-allowed_extensions",
          "ALL",
          "-i",
          `http://127.0.0.1:${String(port)}/${source.id}/index.m3u8`,
        ],
        video: source.audioOnly ? [] : ["0:v:0"],
        audio: ["0:a:0"],
        sourceInfo: { tracks: [] },
      };
    else if (!custom && current) {
      input = {
        ...input,
        args: input.args.map((value) =>
          value.startsWith("rtsp://") ? (current?.primaryUrl ?? value) : value,
        ),
      };
    }
    input = {
      ...input,
      args: input.args.flatMap((value) =>
        value === "-i" ? ["-analyzeduration", "1000000", "-probesize", "65536", value] : [value],
      ),
    };
    const normalize = encoderArguments(
      input,
      { ...options.profile, audioOnly: false, width, height, fps: MIXER_FPS, layout: "grid" },
      "unused",
      options.maxDurationSeconds,
    );
    const args = [
      ...normalize.slice(0, normalize.indexOf("-map")),
      "-map",
      "[vout]",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
      "-map",
      "[aout]",
      "-threads",
      "1",
      "-f",
      "s16le",
      "-ac",
      "2",
      "-ar",
      "48000",
      "pipe:3",
    ];
    const child = track(
      spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
        signal: jobSignal,
        env: custom || source.id === "primary" ? cleanEnv : guardedEnv,
      }),
    );
    d.child = child;
    let diagnostic = "";
    child.stderr?.on("data", (data: Buffer) => {
      diagnostic += data.toString().slice(0, Math.max(0, 8192 - diagnostic.length));
    });
    d.audio = Buffer.alloc(0);
    const video = child.stdout,
      audio = child.stdio[3] as Readable | null;
    if (video) bindVideo(d, video, !!custom);
    if (audio) bindAudio(d, audio, !!custom);
    child.once("close", (code) => {
      if (!jobSignal.aborted && code !== 0)
        console.warn(
          JSON.stringify({
            event: "mixer.decoder.failed",
            sourceId: source.id,
            code,
            diagnostic: encoderDiagnostic(diagnostic, input.args),
          }),
        );
      d.child = undefined;
      d.retryAt = Date.now() + 2000;
    });
    return true;
  }
  async function textRaster(text: MixerScene["texts"][number], index: number) {
    const file = `mixer-text-${String(index)}.txt`;
    await writeFile(`${options.directory}/${file}`, text.text, { mode: 0o600 });
    const args = [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=black@0:s=${String(text.width)}x${String(text.height)}:r=1,format=rgba,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=${file}:expansion=none:fontcolor=0x${text.color.slice(1)}:fontsize=${String(text.fontSize)}:x=0:y=0`,
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "pipe:1",
    ];
    const pixels = await new Promise<Buffer>((resolve, reject) => {
      const child = track(
          spawn(binary, args, {
            cwd: options.directory,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
            signal: jobSignal,
            env: guardedEnv,
          }),
        ),
        parts: Buffer[] = [];
      let bytes = 0;
      const kill = () => {
          child.kill("SIGKILL");
        },
        timer = setTimeout(kill, 5000);
      jobSignal.addEventListener("abort", kill, { once: true });
      child.stdout?.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > text.width * text.height * 4) kill();
        else parts.push(data);
      });
      child.once("error", () => {
        reject(new Error("MIXER_TEXT_FAILED"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        jobSignal.removeEventListener("abort", kill);
        if (code === 0 && bytes === text.width * text.height * 4) resolve(Buffer.concat(parts));
        else reject(new Error("MIXER_TEXT_FAILED"));
      });
    });
    return { width: text.width, height: text.height, pixels };
  }
  async function poll() {
    if (preparing || jobSignal.aborted) return;
    preparing = true;
    try {
      const result = configSchema.parse(await options.control());
      if (!result.mixer) {
        options.onFatal();
        return;
      }
      current = result.mixer;
      for (const [key, d] of decoders)
        if (!current.sources.some((s) => s.id === key)) {
          await stopEncoder(d.child);
          await stopEncoder(d.audioChild);
          decoders.delete(key);
        }
      let needsResume = false;
      for (const source of current.sources) {
        let d = decoders.get(source.id);
        if (!d) {
          d = {
            child: undefined,
            audioChild: undefined,
            width,
            height,
            frame: null,
            frameAt: 0,
            audio: Buffer.alloc(0),
            audioAt: 0,
            sourceId: source.id,
            inputKey: "",
            videoKey: "",
            audioKey: "",
            videoStartedAt: 0,
            videoExpected:
              source.id === "primary" ? options.primary.video.length > 0 : !source.audioOnly,
            audioExpected: true,
            retryAt: 0,
          };
          decoders.set(source.id, d);
        }
        const custom = options.inputForSource?.(source.id);
        const layer = sceneLayers(current.scene).find((l) => l.sourceId === source.id);
        const decodeWidth =
          custom && layer ? Math.max(2, Math.round((layer.width * width) / 640 / 2) * 2) : width;
        const decodeHeight =
          custom && layer ? Math.max(2, Math.round((layer.height * height) / 360 / 2) * 2) : height;
        const inputKey = custom
          ? JSON.stringify([custom.args, custom.sourceInfo, decodeWidth, decodeHeight])
          : "";
        if (custom?.mediaInputs) {
          const videoKey = custom.mediaInputs.video
            ? JSON.stringify([custom.mediaInputs.video.args, decodeWidth, decodeHeight])
            : "";
          const audioKey = custom.mediaInputs.audio
            ? JSON.stringify(custom.mediaInputs.audio.args)
            : "";
          if (d.videoKey !== videoKey) {
            await stopEncoder(d.child);
            d.frame = null;
            d.frameAt = 0;
            d.videoKey = videoKey;
            d.width = decodeWidth;
            d.height = decodeHeight;
            d.retryAt = 0;
          }
          if (d.audioKey !== audioKey) {
            await stopEncoder(d.audioChild);
            d.audio = Buffer.alloc(0);
            d.audioKey = audioKey;
            d.retryAt = 0;
          }
          // UDP receivers cannot request retransmission themselves. Replace a
          // wedged video decoder and request a keyframe after it binds again.
          if (d.child && Date.now() - Math.max(d.frameAt, d.videoStartedAt) > 5000) {
            await stopEncoder(d.child);
            d.retryAt = 0;
          }
        } else if (d.inputKey !== inputKey) {
          await stopEncoder(d.child);
          await stopEncoder(d.audioChild);
          d.frame = null;
          d.audio = Buffer.alloc(0);
          d.width = decodeWidth;
          d.height = decodeHeight;
          d.inputKey = inputKey;
          d.retryAt = 0;
        }
        d.videoExpected = custom
          ? custom.video.length > 0
          : source.id === "primary"
            ? options.primary.video.length > 0
            : !source.audioOnly;
        d.audioExpected = custom ? custom.audio.length > 0 : true;
        needsResume = startDecoder(d, source) || needsResume;
        if (d.videoExpected && Date.now() - d.frameAt > 2000) needsResume = true;
      }
      // Plain RTP exports have no browser receiver sending loss feedback. A
      // bounded two-second keyframe cadence prevents a lost VP8 reference from
      // freezing the program until the next natural camera keyframe.
      if (options.inputForSource && [...decoders.values()].some((d) => d.videoExpected))
        needsResume = true;
      await options.onSourcesReady?.(needsResume);
      if (prepared?.revision === current.revision) {
        preparationFailed = false;
        return;
      }
      const desired = current,
        images = new Map<string, Raster>();
      for (const overlay of desired.scene.overlays)
        if (!images.has(overlay.overlayId))
          images.set(
            overlay.overlayId,
            decodeMixerPng(
              await fetchBody(`/internal/v1/streaming/mixer-assets/${overlay.overlayId}`, 1048576),
            ),
          );
      for (const [index, text] of desired.scene.texts.entries())
        images.set(`text:${text.id}`, await textRaster(text, index));
      if (!isAborted()) {
        prepared = {
          revision: desired.revision,
          sceneId: desired.sceneId,
          scene: desired.scene,
          background: background(desired.scene.background),
          images,
        };
        preparationFailed = false;
      }
    } catch {
      if (!isAborted()) preparationFailed = true;
    } finally {
      preparing = false;
    }
  }
  const raw: EncoderInput = options.profile.audioOnly
    ? {
        args: [
          "-thread_queue_size",
          "4",
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-i",
          "pipe:4",
        ],
        video: [],
        audio: ["0:a:0"],
        sourceInfo: options.primary.sourceInfo,
      }
    : {
        args: [
          "-thread_queue_size",
          "8",
          "-f",
          "rawvideo",
          "-pixel_format",
          pixelFormat,
          "-video_size",
          `${String(width)}x${String(height)}`,
          "-framerate",
          String(MIXER_FPS),
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-i",
          "pipe:3",
          "-thread_queue_size",
          "4",
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-i",
          "pipe:4",
        ],
        video: ["0:v:0"],
        audio: ["1:a:0"],
        sourceInfo: options.primary.sourceInfo,
      };
  const outputArgs = encoderArguments(
    raw,
    options.profile,
    options.programUrl,
    options.maxDurationSeconds,
  );
  // Room composition also decodes and copies full-resolution RTC frames. Keep
  // encoding within the worker CPU budget; direct ingest retains its preset.
  if (options.inputForSource) {
    const preset = outputArgs.indexOf("-preset");
    if (preset >= 0) outputArgs[preset + 1] = "superfast";
  }
  const output = track(
    spawn(binary, ["-progress", "pipe:5", ...outputArgs], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: jobSignal,
      env: cleanEnv,
    }),
  );
  trackEncoderProgress(output, 5);
  let outputDiagnostic = "";
  output.stderr?.on("data", (data: Buffer) => {
    outputDiagnostic += data.toString().slice(0, Math.max(0, 8192 - outputDiagnostic.length));
  });
  output.once("close", (code) => {
    if (code !== 0 && outputDiagnostic)
      console.warn(
        JSON.stringify({
          event: "mixer.output.failed",
          code,
          diagnostic: encoderDiagnostic(outputDiagnostic, [options.programUrl]),
        }),
      );
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const forceCleanup = () => {
    killTimer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 2500);
    killTimer.unref();
  };
  jobSignal.addEventListener("abort", forceCleanup, { once: true });
  const videoOut = output.stdio[3] as Writable,
    audioOut = output.stdio[4] as Writable;
  let videoBusy = false,
    audioBusy = false,
    blockedAt = 0;
  videoOut.on("drain", () => {
    videoBusy = false;
  });
  audioOut.on("drain", () => {
    audioBusy = false;
  });
  videoOut.on("error", () => {
    console.warn(
      JSON.stringify({
        event: "mixer.output.pipe_failed",
        pipe: "video",
        diagnostic: encoderDiagnostic(outputDiagnostic, [options.programUrl]),
      }),
    );
    options.onFatal();
  });
  audioOut.on("error", () => {
    console.warn(
      JSON.stringify({
        event: "mixer.output.pipe_failed",
        pipe: "audio",
        diagnostic: encoderDiagnostic(outputDiagnostic, [options.programUrl]),
      }),
    );
    options.onFatal();
  });
  // FFmpeg opens the raw video input before probing PCM. Supply a bounded
  // startup audio block so probing cannot wait on a clock blocked by video IO.
  audioOut.write(Buffer.alloc(32768));
  const black = background("#000000");
  const lostFor = (scene: PreparedScene | null) => {
    if (!scene) return [];
    const video = new Set(
      scene.scene.layers.filter((layer) => layer.opacity > 0).map((layer) => layer.sourceId),
    );
    const audio = new Set(
      scene.scene.audio.filter((source) => !source.muted).map((source) => source.sourceId),
    );
    return [...new Set([...video, ...audio])].filter((id) => {
      const d = decoders.get(id);
      return (
        !d ||
        (video.has(id) && d.videoExpected && Date.now() - d.frameAt > 2000) ||
        (audio.has(id) && d.audioExpected && Date.now() - d.audioAt > 2000)
      );
    });
  };
  const lost = () => [...new Set([...lostFor(prepared), ...lostFor(displayed)])];
  const clockStarted = performance.now();
  const tick = () => {
    if (closed || jobSignal.aborted) return;
    const begun = Date.now();
    const due = options.inputForSource
      ? dueMixerFrames(performance.now() - clockStarted, frames, MIXER_FPS)
      : 1;
    if (!due) return;
    if (videoBusy || audioBusy) {
      overloadedUntil = begun + 5000;
      if (!blockedAt) blockedAt = begun;
      if (begun - blockedAt > 3000) {
        console.warn(
          JSON.stringify({
            event: "mixer.output.stalled",
            frames,
            diagnostic: encoderDiagnostic(outputDiagnostic, [options.programUrl]),
          }),
        );
        options.onFatal();
      }
      return;
    }
    blockedAt = 0;
    if (prepared && !preparationFailed) displayed = prepared;
    const scene = displayed,
      audioChunks: Buffer[] = [];
    for (let i = 0; i < due; i++) {
      const blocks = new Map<string, Buffer>();
      for (const d of decoders.values()) {
        if (d.audio.length >= PCM_BYTES) {
          if (Date.now() - d.audioAt <= 2000)
            blocks.set(d.sourceId, d.audio.subarray(0, PCM_BYTES));
          d.audio = Buffer.from(d.audio.subarray(PCM_BYTES));
        }
      }
      const mixed = scene
        ? mixAudio(scene.scene, blocks, duck, PCM_BYTES)
        : { output: Buffer.alloc(PCM_BYTES), duck: 1 };
      duck = mixed.duck;
      audioChunks.push(mixed.output);
    }
    for (const d of decoders.values()) {
      d.child?.stdout?.resume();
      (d.child?.stdio[3] as Readable | undefined)?.resume();
    }
    const canvas = Buffer.from(scene?.background.pixels ?? black.pixels);
    if (scene) {
      const layers = [
        ...sceneLayers(scene.scene).map((layer) => ({
          layer,
          // Audio silence/stalls must not suppress a healthy camera. Each
          // medium recovers independently; missing audio is mixed as silence.
          image:
            Date.now() - (decoders.get(layer.sourceId)?.frameAt ?? 0) > 10000
              ? black
              : (decoders.get(layer.sourceId)?.frame ?? black),
        })),
        ...scene.scene.overlays.map((layer) => ({
          layer,
          image: scene.images.get(layer.overlayId) ?? black,
        })),
        ...scene.scene.texts.map((layer) => ({
          layer,
          image: scene.images.get(`text:${layer.id}`) ?? black,
        })),
      ].sort((a, b) => a.layer.z - b.layer.z);
      for (const { layer, image } of layers) {
        if (options.nativeRoomVideo) {
          blitYuv(
            canvas,
            image,
            {
              x: Math.round((layer.x * width) / 640 / 2) * 2,
              y: Math.round((layer.y * height) / 360 / 2) * 2,
              width: Math.max(2, Math.round((layer.width * width) / 640 / 2) * 2),
              height: Math.max(2, Math.round((layer.height * height) / 360 / 2) * 2),
            },
            width,
            height,
          );
          continue;
        }
        blit(
          canvas,
          image,
          {
            ...layer,
            x: Math.round((layer.x * width) / 640),
            y: Math.round((layer.y * height) / 360),
            width:
              Math.round(((layer.x + layer.width) * width) / 640) -
              Math.round((layer.x * width) / 640),
            height:
              Math.round(((layer.y + layer.height) * height) / 360) -
              Math.round((layer.y * height) / 360),
          },
          "fit" in layer ? layer.fit : "contain",
          width,
        );
      }
    }
    // Render the newest picture once. A delayed callback repeats that picture
    // for missed slots instead of permanently slowing the raw media clock.
    // Catch-up is bounded to 250 ms; pipe backpressure still fences all writes.
    for (let i = 0; i < due; i++) {
      if (!options.profile.audioOnly) videoBusy = !videoOut.write(canvas) || videoBusy;
      audioBusy = !audioOut.write(audioChunks[i] ?? Buffer.alloc(PCM_BYTES)) || audioBusy;
    }
    frames += due;
    inputSeconds +=
      ([...decoders.values()].filter(
        (d) =>
          Date.now() - d.audioAt <= 2000 || (d.videoExpected && Date.now() - d.frameAt <= 2000),
      ).length *
        due) /
      MIXER_FPS;
    if (scene && Date.now() >= overloadedUntil && !preparationFailed && !lostFor(scene).length) {
      appliedVersion = scene.revision;
      appliedSceneId = scene.sceneId;
    }
    if (Date.now() - begun > 100) overloadedUntil = Date.now() + 5000;
  };
  let pendingPoll: Promise<void> | undefined;
  const triggerPoll = () => {
    pendingPoll ??= poll().finally(() => {
      pendingPoll = undefined;
    });
  };
  const timer = setInterval(tick, 1000 / MIXER_FPS),
    pollTimer = setInterval(triggerPoll, 2000);
  output.once("error", () => {
    options.onFatal();
  });
  output.once("close", () => {
    if (!closed && !signal.aborted) options.onFatal();
  });
  triggerPoll();
  let previousLost = "";
  return {
    output,
    report: () => {
      const lostSources = lost();
      const key = JSON.stringify(lostSources);
      if (key !== previousLost) {
        previousLost = key;
        console.info(
          JSON.stringify({
            event: "mixer.inputs.changed",
            lostSources,
            inputs: [...decoders.values()].map((d) => ({
              id: d.sourceId,
              videoAgeMs: d.frameAt ? Date.now() - d.frameAt : null,
              audioAgeMs: d.audioAt ? Date.now() - d.audioAt : null,
              videoExpected: d.videoExpected,
              decoding: !!d.child,
            })),
          }),
        );
      }
      return {
        revision: appliedVersion,
        sceneId: appliedSceneId,
        frames,
        inputSeconds,
        lostSources,
        overloaded: Date.now() < overloadedUntil,
        preparationFailed,
      };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      abort.abort();
      clearInterval(timer);
      clearInterval(pollTimer);
      proxy.closeAllConnections();
      proxy.close();
      await pendingPoll;
      await Promise.all([...children].map((child) => stopEncoder(child)));
      clearTimeout(killTimer);
      jobSignal.removeEventListener("abort", forceCleanup);
    },
  };
}
