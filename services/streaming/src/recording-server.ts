import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, open, readFile, stat, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const env = z
  .object({
    STREAMING_API_ORIGIN: z.url(),
    STREAMING_WORKER_KEY: z.string().min(32),
    STREAMING_HEALTH_PORT: z.coerce.number().int().default(8092),
  })
  .parse(process.env);
const origin = new URL(env.STREAMING_API_ORIGIN);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("Invalid recording control origin");
const workerId = `recording-${randomBytes(8).toString("hex")}`;
const shutdown = new AbortController();
const tasks = new Set<Promise<void>>();
let lastControl = 0,
  finalizing = false,
  failures = 0;
const health = createServer((request, response) => {
  if (request.url === "/ready") {
    response.writeHead(!shutdown.signal.aborted && Date.now() - lastControl < 20000 ? 200 : 503);
    response.end();
  } else if (request.url === "/metrics") {
    response.setHeader("content-type", "text/plain; version=0.0.4");
    response.end(
      `relayrtc_recording_worker_jobs ${String(tasks.size)}\nrelayrtc_recording_worker_failures_total ${String(failures)}\nrelayrtc_recording_worker_resident_bytes ${String(process.memoryUsage().rss)}\n`,
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});
health.listen(env.STREAMING_HEALTH_PORT, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    shutdown.abort();
  });
async function call(path: string, token: string, body: unknown, signal: AbortSignal) {
  return retry(async () => {
    const response = await fetch(new URL(`/internal/v1/recordings/${path}`, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RecordingRequestError(
        "RECORDING_CONTROL_UNAVAILABLE",
        response.status >= 500 || response.status === 429,
      );
    }
    lastControl = Date.now();
    return response.json() as Promise<unknown>;
  }, signal);
}
class RecordingRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
async function retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (
        signal.aborted ||
        attempt >= 2 ||
        (error instanceof RecordingRequestError && !error.retryable)
      )
        throw error;
      await delay(250 * 2 ** attempt, undefined, { signal });
    }
  }
}
async function bounded(response: Response, limit = 16777216) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("RECORDING_MEDIA_UNAVAILABLE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("RECORDING_MEDIA_UNAVAILABLE");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > limit) throw new Error("RECORDING_MEDIA_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
const jobSchema = z.object({
  id: z.string(),
  kind: z.enum(["capture", "finalize"]),
  fence: z.number(),
  token: z.string(),
  exportMp4: z.boolean(),
  clip: z
    .object({
      cut_mode: z.enum(["keyframe", "precise"]),
      offset: z.coerce.number().nonnegative(),
      duration: z.coerce.number().positive().max(120),
    })
    .nullable()
    .default(null),
  maxBytes: z.number().int().positive(),
});
async function run(value: unknown) {
  const job = jobSchema.parse(value),
    abort = new AbortController(),
    signal = AbortSignal.any([shutdown.signal, abort.signal]);
  let token = job.token,
    renewed = Date.now(),
    stop = false;
  const shouldStop = () => stop;
  const pulse = async () => {
    const result = z
      .object({ token: z.string(), stop: z.boolean() })
      .parse(await call("heartbeat", token, {}, signal));
    token = result.token;
    renewed = Date.now();
    stop = result.stop;
  };
  const watchdog = setInterval(() => {
    if (Date.now() - renewed > 20000) abort.abort();
  }, 1000);
  let pulsing = false;
  const timer = setInterval(() => {
    if (!pulsing) {
      pulsing = true;
      void pulse()
        .catch(() => {
          abort.abort();
        })
        .finally(() => {
          pulsing = false;
        });
    }
  }, 6000);
  let directory: string | undefined, server: ReturnType<typeof createServer> | undefined;
  try {
    await pulse();
    if (job.kind === "capture") {
      while (!signal.aborted) {
        if (shouldStop()) break;
        const result = z
          .object({ stop: z.boolean() })
          .loose()
          .parse(await call("capture", token, {}, signal));
        if (result.stop) break;
        await delay(1200, undefined, { signal });
      }
      if (!signal.aborted) await call("release", token, {}, signal);
    } else {
      directory = await mkdtemp(join(tmpdir(), "relayrtc-recording-"));
      const mp4 = join(directory, "recording.mp4"),
        thumb = join(directory, "thumbnail.jpg");
      server = createServer((request, response) => {
        void (async () => {
          if (signal.aborted) throw new Error("RECORDING_STOPPED");
          const name = request.url?.slice(1) ?? "";
          if (
            !/^(?:(?:index|video|audio)\.m3u8|init_[a-f0-9]{64}\.mp4|seg_[a-f0-9]{64}\.m4s)$/u.test(
              name,
            )
          )
            throw new Error("RECORDING_INVALID_MEDIA");
          const body = await bounded(
            await fetch(new URL(`/internal/v1/recordings/media/${name}`, origin), {
              headers: { authorization: `Bearer ${token}` },
              redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            }),
          );
          response.writeHead(200, {
            "content-type": name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
            "content-length": body.length,
          });
          response.end(body);
        })().catch(() => {
          response.writeHead(503);
          response.end();
        });
      });
      const bridge = server;
      await new Promise<void>((resolve, reject) => {
        bridge.once("error", reject);
        bridge.listen(0, "127.0.0.1", resolve);
      });
      const address = bridge.address();
      if (!address || typeof address === "string") throw new Error("RECORDING_BRIDGE_FAILED");
      const guard = process.env.STREAMING_EGRESS_GUARD;
      if (process.platform !== "linux" || !guard || !existsSync(guard))
        throw new Error("RECORDING_PROCESS_GUARD_REQUIRED");
      const childEnv = {
        PATH: process.env.PATH,
        LD_PRELOAD: guard,
        RELAYRTC_EGRESS_LOOPBACK_PORTS: `${String(address.port)},${String(address.port)}`,
      };
      const execute = (binary: string, args: string[]) =>
        new Promise<Buffer>((resolve, reject) => {
          const child = spawn(binary, args, {
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
            env: childEnv,
          });
          const chunks: Buffer[] = [];
          let output = 0,
            finished = false;
          const kill = () => {
            child.kill("SIGKILL");
          };
          signal.addEventListener("abort", kill, { once: true });
          const deadline = setTimeout(kill, 300000);
          const disk = setInterval(() => {
            void stat(mp4)
              .then((info) => {
                if (info.size > job.maxBytes) kill();
              })
              .catch(() => undefined);
          }, 250);
          child.stdout.on("data", (data: Buffer) => {
            output += data.length;
            if (output > 262144) kill();
            else chunks.push(data);
          });
          const complete = (error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            clearInterval(disk);
            signal.removeEventListener("abort", kill);
            if (error || signal.aborted) reject(new Error("RECORDING_PROCESS_FAILED"));
            else resolve(Buffer.concat(chunks));
          };
          child.once("error", () => {
            complete(new Error("RECORDING_PROCESS_FAILED"));
          });
          child.once("exit", (code) => {
            complete(code === 0 ? undefined : new Error("RECORDING_PROCESS_FAILED"));
          });
          if (signal.aborted) kill();
        });
      const source = `http://127.0.0.1:${String(address.port)}/index.m3u8`;
      const input = [
        "-protocol_whitelist",
        "file,http,tcp",
        "-allowed_extensions",
        "ALL",
        "-threads",
        "2",
        "-i",
        source,
      ];
      const probe = z
        .object({
          streams: z.array(z.object({ codec_name: z.string(), codec_type: z.string() })),
          format: z.object({ duration: z.coerce.number().positive() }),
        })
        .parse(
          JSON.parse(
            (
              await execute("ffprobe", [
                "-v",
                "error",
                ...input,
                "-show_streams",
                "-show_format",
                "-of",
                "json",
              ])
            ).toString(),
          ),
        );
      const codecs = probe.streams.map((s) => s.codec_name);
      if (!codecs.length || codecs.some((c) => !["h264", "aac"].includes(c)))
        throw new Error("RECORDING_CODEC_UNSUPPORTED");
      let parts = 0;
      let outputDuration = probe.format.duration;
      const upload = async (name: string, body: Buffer) => {
        await retry(async () => {
          const response = await fetch(new URL(`/internal/v1/recordings/upload/${name}`, origin), {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/octet-stream",
            },
            body: new Uint8Array(body),
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new RecordingRequestError(
              "RECORDING_UPLOAD_FAILED",
              response.status >= 500 || response.status === 429,
            );
          }
          await response.body?.cancel();
        }, signal);
      };
      if (job.exportMp4) {
        await execute("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          ...input,
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          ...(job.clip?.cut_mode === "precise"
            ? [
                "-ss",
                String(job.clip.offset),
                "-t",
                String(job.clip.duration),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-threads",
                "2",
              ]
            : ["-c", "copy"]),
          "-movflags",
          "+faststart",
          "-fs",
          String(job.maxBytes),
          "-y",
          mp4,
        ]);
        const info = await stat(mp4);
        if (info.size >= job.maxBytes) throw new Error("RECORDING_EXPORT_TOO_LARGE");
        const verified = z
          .object({ format: z.object({ duration: z.coerce.number().positive() }) })
          .parse(
            JSON.parse(
              (
                await execute("ffprobe", ["-v", "error", "-show_format", "-of", "json", mp4])
              ).toString(),
            ),
          );
        if (
          Math.abs(
            verified.format.duration -
              (job.clip?.cut_mode === "precise" ? job.clip.duration : probe.format.duration),
          ) >
          (job.clip
            ? Math.max(
                0.5,
                (job.clip.cut_mode === "precise" ? job.clip.duration : probe.format.duration) *
                  0.01,
              )
            : Math.max(5, probe.format.duration * 0.03))
        )
          throw new Error("RECORDING_EXPORT_TRUNCATED");
        outputDuration = verified.format.duration;
        await execute("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-err_detect",
          "explode",
          "-threads",
          "2",
          "-i",
          mp4,
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          "-f",
          "null",
          "-",
        ]);
        const file = await open(mp4, "r");
        try {
          for (let offset = 0; offset < info.size; offset += 8388608) {
            const body = Buffer.alloc(Math.min(8388608, info.size - offset));
            const read = await file.read(body, 0, body.length, offset);
            if (read.bytesRead !== body.length) throw new Error("RECORDING_EXPORT_READ_FAILED");
            await upload(`export_part_${String(parts++)}.bin`, body);
          }
        } finally {
          await file.close();
        }
      }
      if (!job.exportMp4)
        await execute("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-err_detect",
          "explode",
          ...input,
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          "-f",
          "null",
          "-",
        ]);
      if (job.clip) {
        const manifest = join(directory, "render.m3u8");
        await execute("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-i",
          mp4,
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          "-c",
          "copy",
          "-f",
          "hls",
          "-hls_time",
          "2",
          "-hls_playlist_type",
          "vod",
          "-hls_segment_type",
          "fmp4",
          "-hls_fmp4_init_filename",
          "render_init.mp4",
          "-hls_segment_filename",
          join(directory, "render_seg_%05d.m4s"),
          "-y",
          manifest,
        ]);
        const names = (await readdir(directory)).filter((n) =>
          /^render(?:_init\.mp4|_seg_\d{5}\.m4s|\.m3u8)$/u.test(n),
        );
        let bytes = 0;
        for (const name of names) {
          const info = await stat(join(directory, name));
          bytes += info.size;
          if (bytes > job.maxBytes || info.size > 8388608)
            throw new Error("CLIP_PACKAGE_TOO_LARGE");
          await upload(`export_${name}`, await readFile(join(directory, name)));
        }
      }
      const hasVideo = probe.streams.some((s) => s.codec_type === "video");
      if (hasVideo) {
        await execute("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          ...(job.clip ? ["-i", mp4] : input),
          "-frames:v",
          "1",
          "-vf",
          "scale=640:-2",
          "-threads",
          "2",
          "-y",
          thumb,
        ]);
        const image = await readFile(thumb);
        if (image.length > 1048576) throw new Error("RECORDING_THUMBNAIL_TOO_LARGE");
        await upload("export_thumb.jpg", image);
      }
      await call(
        "complete",
        token,
        {
          parts,
          thumbnail: hasVideo,
          codecs: [...new Set(codecs)],
          duration: outputDuration,
        },
        signal,
      );
    }
  } catch (error) {
    failures++;
    const known = new Set([
      "RECORDING_CODEC_UNSUPPORTED",
      "RECORDING_EXPORT_TOO_LARGE",
      "RECORDING_EXPORT_TRUNCATED",
      "CLIP_PACKAGE_TOO_LARGE",
      "RECORDING_PROCESS_GUARD_REQUIRED",
      "RECORDING_INVALID_MEDIA",
      "RECORDING_UPLOAD_FAILED",
      "RECORDING_MEDIA_UNAVAILABLE",
      "RECORDING_MEDIA_TOO_LARGE",
      "RECORDING_PROCESS_FAILED",
    ]);
    const code =
      error instanceof Error && known.has(error.message)
        ? error.message
        : "RECORDING_WORKER_FAILED";
    if (!signal.aborted) await call("fail", token, { code }, signal).catch(() => undefined);
  } finally {
    clearInterval(timer);
    clearInterval(watchdog);
    abort.abort();
    server?.closeAllConnections();
    server?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
const isShutdown = () => shutdown.signal.aborted;
for (;;) {
  if (isShutdown()) break;
  try {
    if (tasks.size >= 4) {
      await delay(1000, undefined, { signal: shutdown.signal });
      continue;
    }
    const result = z
      .object({ job: jobSchema.nullable() })
      .parse(
        await call(
          "claim",
          env.STREAMING_WORKER_KEY,
          { workerId, allowFinalize: !finalizing, allowCapture: tasks.size < 3 },
          shutdown.signal,
        ),
      );
    if (result.job) {
      const isFinalize = result.job.kind === "finalize";
      if (isFinalize) finalizing = true;
      const task = run(result.job).finally(() => {
        tasks.delete(task);
        if (isFinalize) finalizing = false;
      });
      tasks.add(task);
    } else await delay(1500, undefined, { signal: shutdown.signal });
  } catch {
    if (!isShutdown())
      await delay(2000, undefined, { signal: shutdown.signal }).catch(() => undefined);
  }
}
await Promise.allSettled(tasks);
health.closeAllConnections();
health.close();
