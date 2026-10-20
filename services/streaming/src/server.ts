import { createGuestStageControl } from "./guest-stage.js";
import { startMixerEngine } from "./mixer-engine.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { ChildProcess } from "node:child_process";
import {
  streamProfileSchema,
  streamSourceSchema,
  streamSourceInfoSchema,
} from "@relayrtc/validation";
import { z } from "zod";
import {
  encoderArguments,
  encoderProgress,
  externalInput,
  roomInput,
  startEncoder,
  stopEncoder,
  type ExportTrack,
} from "./encoder.js";

const environment = z
  .object({
    STREAMING_API_ORIGIN: z.url(),
    STREAMING_WORKER_KEY: z.string().min(32),
    STREAMING_WORKER_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u),
    STREAMING_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
    STREAMING_RTP_PORT_BASE: z.coerce
      .number()
      .int()
      .min(10000)
      .max(64780)
      .multipleOf(2)
      .default(20000),
    STREAMING_FFMPEG: z.string().default("ffmpeg"),
    STREAMING_FFPROBE: z.string().default("ffprobe"),
    STREAMING_HEALTH_PORT: z.coerce.number().int().min(1024).max(65535).default(8090),
  })
  .parse(process.env);
const origin = new URL(environment.STREAMING_API_ORIGIN);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.pathname !== "/" ||
  origin.username ||
  origin.password
)
  throw new Error("Invalid streaming API origin");
const jobSchema = z.object({
  mixerId: z.string().nullable().default(null),
  guestStage: z.boolean().default(false),
  sessionId: z.string(),
  streamId: z.string(),
  generation: z.number().int(),
  source: streamSourceSchema,
  profile: streamProfileSchema,
  maxDurationSeconds: z.number().int(),
  token: z.string(),
  programUrl: z.url(),
  sourceUrl: z.url().nullable(),
  leaseSeconds: z.number().int(),
});
const shutdown = new AbortController();
const encoders = new Set<ChildProcess>();
const jobs = new Map<number, Promise<void>>();
let lastControlSuccess = 0;
let encoderFailures = 0;
const health = createServer((request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(
      `relayrtc_streaming_worker_busy ${String(encoders.size)}\nrelayrtc_streaming_worker_control_age_seconds ${String(lastControlSuccess ? (Date.now() - lastControlSuccess) / 1000 : 999999)}\nrelayrtc_streaming_encoder_failures_total ${String(encoderFailures)}\nrelayrtc_streaming_worker_resident_bytes ${String(process.memoryUsage().rss)}\n`,
    );
  } else if (request.url === "/ready") {
    response.writeHead(
      !shutdown.signal.aborted && Date.now() - lastControlSuccess < 15000 ? 200 : 503,
    );
    response.end();
  } else {
    response.writeHead(404);
    response.end();
  }
});
health.listen(environment.STREAMING_HEALTH_PORT, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    shutdown.abort();
  });
async function call(
  path: string,
  body: unknown,
  token: string,
  signal: AbortSignal = shutdown.signal,
): Promise<unknown> {
  const response = await fetch(new URL(`/internal/v1/streaming/${path}`, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`STREAMING_API_${String(response.status)}`);
  }
  lastControlSuccess = Date.now();
  return response.json();
}
async function reservePorts(portBase: number) {
  const sockets: ReturnType<typeof createSocket>[] = [];
  try {
    for (let offset = 0; offset < 24; offset++) {
      const socket = createSocket("udp4");
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(portBase + offset, "0.0.0.0", () => {
          socket.removeListener("error", reject);
          resolve();
        });
      });
    }
    return sockets;
  } catch (error) {
    for (const socket of sockets)
      try {
        socket.close();
      } catch {
        /* A socket may not yet be bound. */
      }
    throw error;
  }
}
async function runJob(value: unknown, slot: number) {
  let active: ChildProcess | undefined;
  const portBase = environment.STREAMING_RTP_PORT_BASE + slot * 24;
  const job = jobSchema.parse(value),
    abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, shutdown.signal]);
  let token = job.token,
    sequence = 0,
    lastRenewed = Date.now(),
    finished = false;
  const root = resolve(tmpdir()),
    directory = await mkdtemp(join(root, "relayrtc-streaming-"));
  let exportCreated = false,
    heartbeat: Promise<void> | undefined,
    archive: Promise<void> | undefined;
  let mixerEngine: Awaited<ReturnType<typeof startMixerEngine>> | undefined;
  let sourceInfo: z.infer<typeof streamSourceInfoSchema> | undefined;
  const pulse = async () => {
    const result = z
      .object({ stop: z.boolean(), token: z.string().optional(), ready: z.boolean().optional() })
      .parse(
        await call(
          "heartbeat",
          {
            sequence: ++sequence,
            status: "running",
            sourceInfo,
            processing: { encodedSeconds: encoderProgress(active).seconds, composedFrames: mixerEngine?.report().frames ?? 0 },
            ...(mixerEngine ? { mixer: mixerEngine.report() } : {}),
          },
          token,
          signal,
        ),
      );
    if (result.stop) {
      abort.abort();
      return;
    }
    if (result.token) token = result.token;
    lastRenewed = Date.now();
    if (result.ready && !archive)
      archive = call("archive", {}, token, signal)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          archive = undefined;
        });
  };
  const timer = setInterval(() => {
    if (signal.aborted || heartbeat) return;
    heartbeat = pulse()
      .catch(() => {
        if (Date.now() - lastRenewed > 10000) abort.abort();
      })
      .finally(() => {
        heartbeat = undefined;
      });
  }, 4000);
  // Local fencing is independent of an API timeout or archive request.
  const watchdog = setInterval(() => {
    if (Date.now() - lastRenewed > 12000) abort.abort();
  }, 1000);
  try {
    let input;
    if (job.source.kind === "room") {
      const sockets = await reservePorts(portBase);
      try {
        const result = (await call(
          "room-export",
          {
            ports: Array.from({ length: 12 }, (_v, i) => portBase + i * 2),
          },
          token,
          signal,
        )) as { tracks: ExportTrack[] };
        exportCreated = true;
        input = await roomInput(result.tracks, directory);
      } finally {
        for (const socket of sockets) socket.close();
      }
    } else {
      if (!job.sourceUrl) throw new Error("SOURCE_UNAVAILABLE");
      input = await externalInput(job.sourceUrl, environment.STREAMING_FFPROBE, signal);
    }
    sourceInfo = input.sourceInfo;
    if (job.mixerId || job.source.kind === "room") {
      const stageControl =
        job.source.kind === "room"
          ? createGuestStageControl(
              directory,
              () =>
                call(
                  "room-export",
                  { ports: Array.from({ length: 12 }, (_v, i) => portBase + i * 2) },
                  token,
                  signal,
                ),
              job.mixerId ? () => call("mixer", {}, token, signal) : undefined,
            )
          : undefined;
      mixerEngine = await startMixerEngine({
        primary: input,
        profile: job.profile,
        programUrl: job.programUrl,
        maxDurationSeconds: job.maxDurationSeconds,
        directory,
        binary: environment.STREAMING_FFMPEG,
        origin,
        signal,
        token: () => token,
        control: stageControl ? stageControl.control : () => call("mixer", {}, token, signal),
        ...(stageControl
          ? {
              inputForSource: stageControl.inputForSource,
              onSourcesReady: () => {
                sourceInfo = stageControl.sourceInfo();
                return call("room-export/resume", {}, token, signal);
              },
            }
          : {}),
        onFatal: () => {
          abort.abort();
        },
      });
      active = mixerEngine.output;
    } else {
      active = startEncoder(
        environment.STREAMING_FFMPEG,
        encoderArguments(input, job.profile, job.programUrl, job.maxDurationSeconds),
        signal,
      );
    }
    encoders.add(required(active));
    const exited = new Promise<void>((resolve) => {
      const child = required(active);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      required(active).once("error", () => {
        resolve();
      });
      required(active).once("close", () => {
        resolve();
      });
    });
    if (exportCreated) {
      await delay(500, undefined, { signal });
      await call("room-export/resume", {}, token, signal);
    }
    await exited;
    finished = signal.aborted;
  } catch (error) {
    if (!signal.aborted)
      process.stderr.write(
        error instanceof Error && error.message.startsWith("SOURCE_UNAVAILABLE:")
          ? `Streaming input probe failed: ${error.message}\n`
          : "Streaming source setup failed\n",
      );
    finished = signal.aborted;
  } finally {
    if (!finished) encoderFailures++;
    clearInterval(timer);
    clearInterval(watchdog);
    abort.abort();
    await heartbeat;
    await archive;
    await mixerEngine?.close();
    await stopEncoder(active);
    if (active) encoders.delete(active);
    const finalProcessing = { encodedSeconds: encoderProgress(active).seconds, composedFrames: mixerEngine?.report().frames ?? 0 };
    active = undefined;
    const finalSignal = AbortSignal.timeout(5000);
    if (exportCreated)
      await call("room-export/close", {}, token, finalSignal).catch(() => undefined);
    await call(
      "heartbeat",
      {
        sequence: ++sequence,
        status: finished ? "stopped" : "failed",
        processing: finalProcessing,
        error: shutdown.signal.aborted ? "WORKER_SHUTDOWN" : "ENCODER_EXITED",
      },
      token,
      finalSignal,
    ).catch(() => undefined);
    // This directory is created by this process. Verify its boundary before recursive cleanup.
    await removeWorkDirectory(root, directory);
  }
}
while (!shutdown.signal.aborted) {
  try {
    const slot = Array.from({ length: environment.STREAMING_WORKER_CONCURRENCY }, (_, i) => i).find(
      (i) => !jobs.has(i),
    );
    if (slot === undefined) {
      await delay(500, undefined, { signal: shutdown.signal });
      continue;
    }
    const result = (await call(
      "claim",
      { workerId: environment.STREAMING_WORKER_ID },
      environment.STREAMING_WORKER_KEY,
    )) as { job: unknown };
    if (result.job) {
      const task = runJob(result.job, slot)
        .catch(() => {
          encoderFailures++;
          process.stderr.write("Streaming job setup failed\n");
        })
        .finally(() => {
          jobs.delete(slot);
        });
      jobs.set(slot, task);
    } else await delay(1000, undefined, { signal: shutdown.signal });
  } catch {
    if (!isShuttingDown()) {
      process.stderr.write("Streaming worker will retry its control connection\n");
      await delay(2000, undefined, { signal: shutdown.signal }).catch(() => undefined);
    }
  }
}
await Promise.allSettled([...jobs.values()]);
await Promise.all([...encoders].map((encoder) => stopEncoder(encoder)));
await new Promise<void>((resolve) => {
  health.close(() => {
    resolve();
  });
});

function isShuttingDown() {
  return shutdown.signal.aborted;
}
async function removeWorkDirectory(root: string, directory: string) {
  const target = resolve(directory);
  if (
    !target.startsWith(root + sep) ||
    !target.slice(root.length + 1).startsWith("relayrtc-streaming-")
  )
    throw new Error("INVALID_WORK_DIRECTORY");
  await rm(target, { recursive: true, force: true });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required streaming value is missing");
  return value;
}
