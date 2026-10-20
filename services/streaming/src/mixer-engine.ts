import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { mixerSceneSchema } from "@relayrtc/validation";
import { decodeMixerPng } from "@relayrtc/protocol/mixer-png";
import type { MixerScene, StreamProfile } from "@relayrtc/types";
import { encoderArguments, encoderDiagnostic, stopEncoder, trackEncoderProgress, type EncoderInput } from "./encoder.js";
import {
  solid,
  blit,
  mixAudio,
  sceneLayers,
  MIXER_FPS,
  PCM_BYTES,
  type Raster,
} from "./mixer-canvas.js";

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
  frame: Raster | null;
  frameAt: number;
  audio: Buffer;
  audioAt: number;
  partial: Buffer;
  sourceId: string;
  inputKey: string;
  videoExpected: boolean;
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
  primary: EncoderInput;
  inputForSource?: (sourceId: string) => EncoderInput | undefined;
  onSourcesReady?: () => Promise<unknown>;
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
  function startDecoder(
    d: Decoder,
    source: NonNullable<z.infer<typeof configSchema>["mixer"]>["sources"][number],
  ) {
    if (d.child || Date.now() < d.retryAt || jobSignal.aborted) return;
    const custom = options.inputForSource?.(source.id);
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
      { ...options.profile, audioOnly: false, width: 320, height: 180, fps: 15, layout: "grid" },
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
    d.partial = Buffer.alloc(0);
    d.audio = Buffer.alloc(0);
    const video = child.stdout,
      audio = child.stdio[3] as Readable | null;
    video?.on("data", (data: Buffer) => {
      const bytes = Buffer.concat([d.partial, data]),
        size = 320 * 180 * 4,
        count = Math.floor(bytes.length / size);
      if (count) {
        d.frame = {
          width: 320,
          height: 180,
          pixels: Buffer.from(bytes.subarray((count - 1) * size, count * size)),
        };
        d.frameAt = Date.now();
        video.pause();
      }
      d.partial = Buffer.from(bytes.subarray(count * size));
    });
    audio?.on("data", (data: Buffer) => {
      const combined = Buffer.concat([d.audio, data]);
      d.audio = Buffer.from(
        combined.subarray(Math.max(0, Math.ceil((combined.length - PCM_BYTES * 3) / 4) * 4)),
      );
      d.audioAt = Date.now();
      if (d.audio.length >= PCM_BYTES * 2) audio.pause();
    });
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
          decoders.delete(key);
        }
      for (const source of current.sources) {
        let d = decoders.get(source.id);
        if (!d) {
          d = {
            child: undefined,
            frame: null,
            frameAt: 0,
            audio: Buffer.alloc(0),
            audioAt: 0,
            partial: Buffer.alloc(0),
            sourceId: source.id,
            inputKey: "",
            videoExpected:
              source.id === "primary" ? options.primary.video.length > 0 : !source.audioOnly,
            retryAt: 0,
          };
          decoders.set(source.id, d);
        }
        const custom = options.inputForSource?.(source.id),
          inputKey = custom ? JSON.stringify([custom.args, custom.sourceInfo]) : "";
        if (d.inputKey !== inputKey) {
          await stopEncoder(d.child);
          d.frame = null;
          d.audio = Buffer.alloc(0);
          d.inputKey = inputKey;
          d.retryAt = 0;
        }
        d.videoExpected = custom
          ? custom.video.length > 0
          : source.id === "primary"
            ? options.primary.video.length > 0
            : !source.audioOnly;
        startDecoder(d, source);
      }
      await options.onSourcesReady?.();
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
          background: solid(desired.scene.background),
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
          "2",
          "-f",
          "rawvideo",
          "-pixel_format",
          "rgba",
          "-video_size",
          "640x360",
          "-framerate",
          "15",
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
  const output = track(
    spawn(
      binary,
      ["-progress", "pipe:5", ...encoderArguments(raw, options.profile, options.programUrl, options.maxDurationSeconds)],
      {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
        signal: jobSignal,
        env: cleanEnv,
      },
    ),
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
  const black = solid("#000000");
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
        (audio.has(id) && Date.now() - d.audioAt > 2000)
      );
    });
  };
  const lost = () => [...new Set([...lostFor(prepared), ...lostFor(displayed)])];
  const tick = () => {
    if (closed || jobSignal.aborted) return;
    const begun = Date.now();
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
    if (
      prepared &&
      !preparationFailed &&
      Date.now() >= overloadedUntil &&
      !lostFor(prepared).length
    )
      displayed = prepared;
    const scene = displayed,
      unavailable = new Set(lost()),
      blocks = new Map<string, Buffer>();
    for (const d of decoders.values()) {
      if (d.audio.length >= PCM_BYTES) {
        if (Date.now() - d.audioAt <= 2000) blocks.set(d.sourceId, d.audio.subarray(0, PCM_BYTES));
        d.audio = Buffer.from(d.audio.subarray(PCM_BYTES));
      }
      d.child?.stdout?.resume();
      (d.child?.stdio[3] as Readable | undefined)?.resume();
    }
    const canvas = Buffer.from(scene?.background.pixels ?? black.pixels);
    if (scene && Date.now() >= overloadedUntil) {
      const layers = [
        ...sceneLayers(scene.scene).map((layer) => ({
          layer,
          image: unavailable.has(layer.sourceId)
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
      for (const { layer, image } of layers)
        blit(canvas, image, layer, "fit" in layer ? layer.fit : "contain");
    }
    const mixed = scene
      ? mixAudio(scene.scene, blocks, duck)
      : { output: Buffer.alloc(PCM_BYTES), duck: 1 };
    duck = mixed.duck;
    videoBusy = !options.profile.audioOnly && !videoOut.write(canvas);
    audioBusy = !audioOut.write(
      Date.now() < overloadedUntil ? Buffer.alloc(PCM_BYTES) : mixed.output,
    );
    frames++;
    inputSeconds += [...decoders.values()].filter((d) => Date.now() - d.audioAt <= 2000 || (d.videoExpected && Date.now() - d.frameAt <= 2000)).length / MIXER_FPS;
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
