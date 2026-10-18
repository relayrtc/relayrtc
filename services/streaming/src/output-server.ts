import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { HlsProgramAdapter, type OutputAdapter } from "./output-adapters.js";
import { RtmpOutputAdapter } from "./rtmp-output.js";

const environment = z
  .object({
    STREAMING_API_ORIGIN: z.url(),
    STREAMING_WORKER_KEY: z.string().min(32),
    STREAMING_WORKER_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u),
    STREAMING_OUTPUT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    STREAMING_HEALTH_PORT: z.coerce.number().int().min(1024).max(65535).default(8091),
  })
  .parse(process.env);
const workerIdentity = `${environment.STREAMING_WORKER_ID.slice(0, 60)}-${randomBytes(6).toString("hex")}`;
const origin = new URL(environment.STREAMING_API_ORIGIN);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("Invalid broadcast API origin");
const jobSchema = z.object({
  id: z.string(),
  broadcastId: z.string(),
  outputId: z.string(),
  kind: z.enum(["hls", "rtmp"]),
  destination: z
    .object({
      endpoint: z.string(),
      streamKey: z.string(),
      profile: z.enum(["remux", "720p", "1080p"]),
    })
    .optional(),
  fence: z.number().int(),
  token: z.string(),
  leaseSeconds: z.number().int(),
  source: z.object({
    streamId: z.string(),
    sessionId: z.string(),
    generation: z.number().int(),
    profile: z.object({ audioOnly: z.boolean() }).optional(),
  }),
});
const sourceSchema = z.object({
  sourceSessionId: z.string(),
  sourceGeneration: z.number().int(),
  bytesObserved: z.number().nonnegative(),
});
const shutdown = new AbortController(),
  tasks = new Set<Promise<void>>();
let lastControl = 0,
  failures = 0,
  draining = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    shutdown.abort();
  });
async function call(
  path: string,
  body: unknown,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(new URL(`/internal/v1/broadcasts/${path}`, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("OUTPUT_CONTROL_UNAVAILABLE");
  }
  lastControl = Date.now();
  return response.json();
}
const server = createServer((request, response) => {
  if (request.url === "/ready") {
    response.writeHead(!shutdown.signal.aborted && Date.now() - lastControl < 15000 ? 200 : 503);
    response.end();
  } else if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(
      `relayrtc_broadcast_worker_jobs ${String(tasks.size)}\nrelayrtc_broadcast_worker_capacity ${String(environment.STREAMING_OUTPUT_CONCURRENCY)}\nrelayrtc_broadcast_worker_failures_total ${String(failures)}\nrelayrtc_broadcast_worker_draining ${draining ? "1" : "0"}\nrelayrtc_broadcast_worker_resident_bytes ${String(process.memoryUsage().rss)}\n`,
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});
server.listen(environment.STREAMING_HEALTH_PORT, "0.0.0.0");
async function runJob(value: unknown): Promise<void> {
  const job = jobSchema.parse(value),
    abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, shutdown.signal]);
  let token = job.token,
    sequence = 0,
    renewedAt = Date.now(),
    heartbeat: Promise<void> | undefined;
  let failed = false;
  let reason = "OUTPUT_UNAVAILABLE";
  const adapter: OutputAdapter =
    job.kind === "rtmp" && job.destination
      ? new RtmpOutputAdapter(
          job.destination,
          async (name, readSignal) => {
            const response = await fetch(new URL(`/internal/v1/broadcasts/media/${name}`, origin), {
              headers: { authorization: `Bearer ${token}` },
              redirect: "error",
              signal: readSignal,
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error("OUTPUT_UNAVAILABLE");
            }
            const reader = response.body?.getReader();
            if (!reader) throw new Error("OUTPUT_UNAVAILABLE");
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.length;
                if (size > 16777216) throw new Error("OUTPUT_UNAVAILABLE");
                chunks.push(next.value);
              }
            } finally {
              await reader.cancel();
            }
            return Buffer.concat(chunks);
          },
          job.source.profile?.audioOnly ?? false,
        )
      : new HlsProgramAdapter(job.source, async (readSignal) =>
          sourceSchema.parse(await call("source", {}, token, readSignal)),
        );
  let previousBytes = 0,
    previousAt = Date.now();
  const pulse = async () => {
    const report = adapter.report();
    const bitrate =
      job.kind === "rtmp"
        ? Math.max(
            0,
            ((report.bytesObserved - previousBytes) * 8000) / Math.max(1, Date.now() - previousAt),
          )
        : 0;
    previousBytes = report.bytesObserved;
    previousAt = Date.now();
    const result = z.object({ stop: z.boolean(), token: z.string().optional() }).parse(
      await call(
        "heartbeat",
        {
          sequence: ++sequence,
          status: "running",
          live: report.live,
          bytes: job.kind === "rtmp" ? report.bytesObserved : 0,
          bitrate,
          droppedFrames: report.droppedFrames ?? 0,
        },
        token,
        signal,
      ),
    );
    if (result.token) token = result.token;
    renewedAt = Date.now();
    if (result.stop) abort.abort();
  };
  const timer = setInterval(() => {
    if (heartbeat || signal.aborted) return;
    heartbeat = pulse()
      .catch(() => {
        if (Date.now() - renewedAt > 10000) abort.abort();
      })
      .finally(() => {
        heartbeat = undefined;
      });
  }, 4000);
  const watchdog = setInterval(() => {
    if (Date.now() - renewedAt >= 12000) abort.abort();
  }, 1000);
  try {
    await adapter.connect(signal);
    await adapter.start(signal);
    let unsuccessful = 0;
    while (!isAborted(signal)) {
      await delay(2000, undefined, { signal });
      try {
        await adapter.health(signal);
        unsuccessful = 0;
      } catch (error) {
        if (isAborted(signal)) break;
        if (++unsuccessful >= 3) throw error;
      }
    }
  } catch (error) {
    failed = !signal.aborted;
    if (
      error instanceof Error &&
      [
        "OUTPUT_TIMEOUT",
        "DESTINATION_ADDRESS_REJECTED",
        "DESTINATION_CONNECTION_FAILED",
        "DESTINATION_TLS_FAILED",
        "DESTINATION_ENCODER_FAILED",
      ].includes(error.message)
    )
      reason = error.message;
  } finally {
    clearInterval(timer);
    clearInterval(watchdog);
    abort.abort();
    await heartbeat;
    await adapter.stop();
    if (failed) failures++;
    await call(
      "heartbeat",
      {
        sequence: ++sequence,
        status: failed ? "failed" : "stopped",
        live: false,
        bytes: job.kind === "rtmp" ? adapter.report().bytesObserved : 0,
        droppedFrames: adapter.report().droppedFrames ?? 0,
        ...(failed
          ? { error: reason }
          : shutdown.signal.aborted
            ? { error: "WORKER_SHUTDOWN" }
            : {}),
      },
      token,
      AbortSignal.timeout(5000),
    ).catch(() => undefined);
  }
}
try {
  while (!shutdown.signal.aborted) {
    try {
      if (tasks.size < environment.STREAMING_OUTPUT_CONCURRENCY) {
        const result = z
          .object({ job: z.unknown().nullable(), draining: z.boolean().optional() })
          .parse(
            await call(
              "claim",
              { workerId: workerIdentity, kinds: ["hls", "rtmp"] },
              environment.STREAMING_WORKER_KEY,
              shutdown.signal,
            ),
          );
        draining = result.draining ?? false;
        if (result.job) {
          const task = runJob(result.job)
            .catch(() => {
              failures++;
            })
            .finally(() => {
              tasks.delete(task);
            });
          tasks.add(task);
          continue;
        }
      }
      await delay(1000, undefined, { signal: shutdown.signal });
    } catch {
      if (!isAborted(shutdown.signal))
        await delay(2000, undefined, { signal: shutdown.signal }).catch(() => undefined);
    }
  }
} finally {
  shutdown.abort();
  await Promise.allSettled(tasks);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
