import { createServer as createHealthServer } from "node:http";
import { createServer, connect, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SourceTransport } from "./source-transport.js";
const env = z
  .object({
    STREAMING_API_ORIGIN: z.url(),
    STREAMING_WORKER_KEY: z.string().min(32),
    STREAMING_WORKER_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u),
    STREAMING_EGRESS_GUARD: z.string().min(1),
    STREAMING_HEALTH_PORT: z.coerce.number().int().min(1024).max(65535).default(8093),
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
  throw new Error("Invalid source control origin");
if (process.platform !== "linux") throw new Error("Source workers require the guarded Linux image");
await access(env.STREAMING_EGRESS_GUARD);
const jobSchema = z.object({
  id: z.string(),
  kind: z.enum(["probe", "pull"]),
  token: z.string().min(32),
  endpoint: z.url(),
  authorization: z.string(),
  allowedHosts: z.array(z.string()),
  maxBytes: z.number().positive(),
  maxDurationSeconds: z.number().positive(),
  publishUrl: z.url().nullable(),
});
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    shutdown.abort();
  });
let active = false,
  lastControl = 0,
  totalBytes = 0,
  failures = 0;
const health = createHealthServer((request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(
      `relayrtc_restream_worker_busy ${active ? "1" : "0"}\nrelayrtc_restream_fetched_bytes_total ${String(totalBytes)}\nrelayrtc_restream_failures_total ${String(failures)}\n`,
    );
  } else if (request.url === "/ready") {
    response.writeHead(!shutdown.signal.aborted && Date.now() - lastControl < 15000 ? 200 : 503);
    response.end();
  } else {
    response.writeHead(404);
    response.end();
  }
});
health.listen(env.STREAMING_HEALTH_PORT, "0.0.0.0");
async function call(
  path: string,
  body: unknown,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(new URL(`/internal/v1/restream/${path}`, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("SOURCE_CONTROL_UNAVAILABLE");
  }
  lastControl = Date.now();
  return response.json();
}
async function execute(job: z.infer<typeof jobSchema>) {
  const abort = new AbortController(),
    signal = AbortSignal.any([
      shutdown.signal,
      abort.signal,
      AbortSignal.timeout(job.maxDurationSeconds * 1000),
    ]),
    transport = new SourceTransport(
      job.endpoint,
      job.authorization,
      job.allowedHosts,
      job.maxBytes,
      signal,
    ),
    sockets = new Set<Socket>();
  let reason: "SOURCE_PROFILE_UNSUPPORTED" | "SOURCE_FETCH_FAILED" | "SOURCE_PROCESSING_FAILED" =
    "SOURCE_PROCESSING_FAILED";
  let child: ChildProcess | undefined,
    proxy: ReturnType<typeof createServer> | undefined,
    heartbeat: Promise<void> | undefined,
    pending:
      | {
          sequence: number;
          status: "running" | "ready" | "failed" | "stopped";
          fetchedBytes: number;
          processingSeconds: number;
          reason?:
            "SOURCE_PROFILE_UNSUPPORTED" | "SOURCE_FETCH_FAILED" | "SOURCE_PROCESSING_FAILED";
        }
      | undefined,
    sequence = 0,
    renewed = Date.now(),
    begun = 0,
    probeOutput = "",
    result: "ready" | "failed" | "stopped" = "failed";
  const pulse = async (status: "running" | "ready" | "failed" | "stopped") => {
    pending ??= {
      sequence: ++sequence,
      status,
      fetchedBytes: transport.bytes,
      processingSeconds: begun ? (Date.now() - begun) / 1000 : 0,
      ...(status === "failed" ? { reason } : {}),
    };
    const response = z
      .object({ stop: z.boolean() })
      .parse(await call("heartbeat", pending, job.token, AbortSignal.timeout(8000)));
    pending = undefined;
    renewed = Date.now();
    if (response.stop) abort.abort();
  };
  const timer = setInterval(() => {
    if (!heartbeat && !signal.aborted)
      heartbeat = pulse("running")
        .catch(() => undefined)
        .finally(() => {
          heartbeat = undefined;
        });
    if (Date.now() - renewed > 11000) abort.abort();
  }, 2000);
  try {
    active = true;
    const input = await transport.start();
    const ports = [input.port];
    let output = "";
    if (job.kind === "pull") {
      if (!job.publishUrl) throw new Error("SOURCE_PUBLISH_UNAVAILABLE");
      const target = new URL(job.publishUrl);
      if (
        target.protocol !== "rtmp:" ||
        target.username ||
        target.password ||
        target.port !== "1935" ||
        !/^\/ingest_[A-Za-z0-9_-]+$/u.test(target.pathname)
      )
        throw new Error("SOURCE_PUBLISH_REJECTED");
      proxy = createServer((local) => {
        if (sockets.size >= 2) {
          local.destroy();
          return;
        }
        const remote = connect({ host: target.hostname, port: 1935 });
        sockets.add(local);
        sockets.add(remote);
        remote.setTimeout(15000, () => remote.destroy());
        local.once("error", () => remote.destroy());
        remote.once("error", () => local.destroy());
        local.once("close", () => {
          sockets.delete(local);
          remote.destroy();
        });
        remote.once("close", () => {
          sockets.delete(remote);
          local.destroy();
        });
        local.pipe(remote);
        remote.pipe(local);
      });
      await new Promise<void>((resolve, reject) => {
        if (!proxy) {
          reject(new Error("SOURCE_PROXY_FAILED"));
          return;
        }
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("SOURCE_PROXY_FAILED");
      ports.push(address.port);
      target.hostname = "127.0.0.1";
      target.port = String(address.port);
      output = target.href;
    }
    const processEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LD_PRELOAD: env.STREAMING_EGRESS_GUARD,
      RELAYRTC_EGRESS_LOOPBACK_PORTS: [ports[0], ports[1] ?? ports[0]].join(","),
    };
    const common = [
      "-v",
      "error",
      "-protocol_whitelist",
      "http,tcp",
      "-rw_timeout",
      "10000000",
      "-analyzeduration",
      "2000000",
      "-probesize",
      "2000000",
    ];
    // Probe with the same guarded nested fetch path that production encoding will use.
    begun = Date.now();
    child = spawn("ffprobe", [...common, "-show_streams", "-of", "json", input.url], {
      env: processEnv,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      probeOutput += chunk.toString();
      if (probeOutput.length > 262144) child?.kill("SIGKILL");
    });
    await exited(child);
    transport.assertHealthy();
    const probe = z
      .object({
        streams: z
          .array(
            z.object({
              codec_type: z.string(),
              codec_name: z.string().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
            }),
          )
          .min(1)
          .max(12),
      })
      .parse(JSON.parse(probeOutput));
    if (
      probe.streams.some((s) =>
        s.codec_type === "video"
          ? s.codec_name !== "h264" || (s.width ?? 0) > 3840 || (s.height ?? 0) > 2160
          : s.codec_type === "audio"
            ? s.codec_name !== "aac"
            : true,
      )
    )
      throw new Error("SOURCE_PROFILE_UNSUPPORTED");
    if (job.kind === "probe") {
      result = "ready";
      return;
    }
    child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        ...common,
        "-fflags",
        "+genpts+discardcorrupt",
        "-i",
        input.url,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-t",
        String(job.maxDurationSeconds),
        "-f",
        "flv",
        output,
      ],
      { env: processEnv, stdio: "ignore", windowsHide: true, signal },
    );
    await exited(child);
    transport.assertHealthy();
    result = "stopped";
  } catch (caught) {
    const error = transport.getFailure() ?? caught;
    reason =
      error instanceof Error && error.message === "SOURCE_PROFILE_UNSUPPORTED"
        ? "SOURCE_PROFILE_UNSUPPORTED"
        : error instanceof Error && error.message === "SOURCE_FETCH_FAILED"
          ? "SOURCE_FETCH_FAILED"
          : "SOURCE_PROCESSING_FAILED";
    result = signal.aborted ? "stopped" : "failed";
    if (result === "failed") failures++;
  } finally {
    clearInterval(timer);
    abort.abort();
    await heartbeat;
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        child?.once("close", () => {
          resolve();
        }),
      );
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      if (proxy)
        proxy.close(() => {
          resolve();
        });
      else resolve();
    });
    await transport.close();
    // Finish an uncertain observation using its original sequence before sending the final state.
    if (pending) await pulse("running").catch(() => undefined);
    if (!pending) await pulse(result).catch(() => undefined);
    totalBytes += transport.bytes;
    active = false;
  }
}
async function exited(child: ChildProcess) {
  await new Promise<void>((resolve, reject) => {
    child.once("error", () => {
      reject(new Error("SOURCE_PROCESSING_FAILED"));
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("SOURCE_PROCESSING_FAILED"));
    });
  });
}
while (!shutdown.signal.aborted) {
  try {
    const response = z
      .object({ job: jobSchema.nullable() })
      .parse(
        await call(
          "claim",
          { workerId: env.STREAMING_WORKER_ID },
          env.STREAMING_WORKER_KEY,
          shutdown.signal,
        ),
      );
    if (response.job) await execute(response.job);
    else await delay(1000, undefined, { signal: shutdown.signal });
  } catch {
    await delay(2000, undefined, { signal: shutdown.signal }).catch(() => undefined);
  }
}
await new Promise<void>((resolve) =>
  health.close(() => {
    resolve();
  }),
);
