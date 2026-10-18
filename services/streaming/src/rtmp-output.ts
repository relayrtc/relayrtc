import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, connect, type Server, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolveEgressDestination } from "@relayrtc/protocol/egress-security";
import { streamingObjectNameSchema } from "@relayrtc/validation";
import type { OutputAdapter, OutputHealth } from "./output-adapters.js";

export interface RtmpDestination {
  endpoint: string;
  streamKey: string;
  profile: "remux" | "720p" | "1080p";
}
/** FFmpeg can reach only loopback proxies. The outbound proxy pins a validated IP,
 * implements TLS/SNI/certificate validation and accounts actual socket bytes. */
export class RtmpOutputAdapter implements OutputAdapter {
  private bridge: HttpServer | undefined;
  private proxy: Server | undefined;
  private process: ChildProcess | undefined;
  private sockets = new Set<Socket>();
  private bytes = 0;
  private lastProgress = 0;
  private mediaTime = -1;
  private dropped = 0;
  private begun = 0;
  private error: string | undefined;
  private address: Awaited<ReturnType<typeof resolveEgressDestination>> | undefined;
  private stopped = false;
  constructor(
    private readonly destination: RtmpDestination,
    private readonly read: (name: string, signal: AbortSignal) => Promise<Buffer>,
    private readonly audioOnly = false,
  ) {}
  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      this.address = await resolveEgressDestination(this.destination.endpoint);
    } catch {
      throw new Error("DESTINATION_ADDRESS_REJECTED");
    }
  }
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const target = this.address;
    if (!target) throw new Error("DESTINATION_ADDRESS_REJECTED");
    const guard = process.env.STREAMING_EGRESS_GUARD;
    if (process.platform !== "linux" || !guard) throw new Error("DESTINATION_ENCODER_FAILED");
    await access(guard);
    this.begun = Date.now();
    this.bridge = createHttpServer((request, response) => {
      void (async () => {
        if (request.method !== "GET" || this.stopped) throw new Error("OUTPUT_CANCELLED");
        const name = streamingObjectNameSchema.parse((request.url ?? "").slice(1));
        const body = await this.read(name, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        response.writeHead(200, {
          "content-type": name.endsWith("m3u8")
            ? "application/vnd.apple.mpegurl"
            : "application/octet-stream",
          "content-length": body.length,
        });
        response.end(body);
      })().catch(() => {
        response.writeHead(503);
        response.end();
      });
    });
    this.proxy = createServer((local) => {
      if (this.stopped || this.sockets.size) {
        local.destroy();
        return;
      }
      this.sockets.add(local);
      const remote = target.secure
        ? connectTls({
            host: target.address,
            port: target.port,
            servername: target.hostname,
            rejectUnauthorized: true,
          })
        : connect({ host: target.address, family: target.family, port: target.port });
      this.sockets.add(remote);
      let counted = 0;
      const observe = () => {
        this.bytes += Math.max(0, remote.bytesWritten - counted);
        counted = remote.bytesWritten;
      };
      const fail = () => {
        this.error = target.secure ? "DESTINATION_TLS_FAILED" : "DESTINATION_CONNECTION_FAILED";
        observe();
        local.destroy();
        remote.destroy();
      };
      remote.setTimeout(15000, fail);
      remote.once("error", fail);
      local.once("error", () => {
        remote.destroy();
      });
      const counter = setInterval(observe, 500);
      remote.once("close", () => {
        observe();
        clearInterval(counter);
        this.sockets.delete(remote);
        local.destroy();
      });
      local.once("close", () => {
        this.sockets.delete(local);
        remote.destroy();
      });
      local.pipe(remote);
      remote.pipe(local);
    });
    await Promise.all([listen(this.bridge), listen(this.proxy)]);
    signal.throwIfAborted();
    const inputPort = port(this.bridge),
      outputPort = port(this.proxy);
    const codec =
      this.destination.profile === "remux"
        ? ["-c", "copy"]
        : [
            ...(this.audioOnly
              ? []
              : [
                  "-c:v",
                  "libx264",
                  "-preset",
                  "veryfast",
                  "-pix_fmt",
                  "yuv420p",
                  "-vf",
                  this.destination.profile === "720p"
                    ? "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"
                    : "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                  "-r",
                  "30",
                  "-g",
                  "60",
                  "-b:v",
                  this.destination.profile === "720p" ? "2500k" : "5000k",
                  "-maxrate",
                  this.destination.profile === "720p" ? "2500k" : "5000k",
                  "-bufsize",
                  this.destination.profile === "720p" ? "5000k" : "10000k",
                  "-threads",
                  "2",
                ]),
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
          ];
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-filter_threads",
      "2",
      "-progress",
      "pipe:1",
      "-stats_period",
      "1",
      "-protocol_whitelist",
      "http,tcp",
      "-rw_timeout",
      "10000000",
      "-re",
      "-i",
      `http://127.0.0.1:${String(inputPort)}/index.m3u8`,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      ...codec,
      "-protocol_whitelist",
      "rtmp,tcp",
      "-rw_timeout",
      "10000000",
      "-rtmp_tcurl",
      this.destination.endpoint,
      "-rtmp_app",
      target.path.slice(1),
      "-rtmp_playpath",
      this.destination.streamKey,
      "-flvflags",
      "no_duration_filesize",
      "-f",
      "flv",
      `rtmp://127.0.0.1:${String(outputPort)}/relayrtc/output`,
    ];
    this.process = spawn(process.env.STREAMING_FFMPEG ?? "ffmpeg", args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        LD_PRELOAD: guard,
        RELAYRTC_EGRESS_LOOPBACK_PORTS: `${String(inputPort)},${String(outputPort)}`,
      },
    });
    this.process.once("error", () => {
      this.error = "DESTINATION_ENCODER_FAILED";
    });
    this.process.once("exit", () => {
      if (!this.stopped) this.error ??= "DESTINATION_ENCODER_FAILED";
    });
    let progress = "";
    this.process.stdout?.on("data", (chunk: Buffer) => {
      progress += chunk.toString();
      if (progress.length > 65536) progress = "";
      const lines = progress.split("\n");
      progress = lines.pop() ?? "";
      for (const line of lines) {
        const [name, value] = line.trim().split("=");
        if (
          name === "out_time_us" &&
          value &&
          Number.isFinite(Number(value)) &&
          Number(value) > 0 &&
          Number(value) > this.mediaTime
        ) {
          this.mediaTime = Number(value);
          this.lastProgress = Date.now();
        }
        if (name === "drop_frames" && value && Number.isFinite(Number(value)))
          this.dropped = Math.max(this.dropped, Number(value));
      }
    });
  }
  health(signal: AbortSignal): Promise<OutputHealth> {
    signal.throwIfAborted();
    if (this.error) return Promise.reject(new Error(this.error));
    if (Date.now() - this.begun > 20000 && Date.now() - this.lastProgress > 10000)
      return Promise.reject(new Error("OUTPUT_TIMEOUT"));
    return Promise.resolve(this.report());
  }
  report(): OutputHealth {
    return {
      live: !this.stopped && !this.error && this.bytes > 0 && Date.now() - this.lastProgress < 8000,
      bytesObserved: this.bytes,
      droppedFrames: this.dropped,
    };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    // Cut network access before waiting for encoder teardown, including on lease loss.
    for (const socket of this.sockets) socket.destroy();
    this.bridge?.closeAllConnections();
    const child = this.process;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      child.kill("SIGTERM");
      await Promise.race([ended, delay(3000)]);
      if (isRunning(child)) {
        child.kill("SIGKILL");
        await Promise.race([ended, delay(2000)]);
      }
    }
    await Promise.all([close(this.bridge), close(this.proxy)]);
  }
}
function port(server: Server | HttpServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OUTPUT_UNAVAILABLE");
  return address.port;
}
function isRunning(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null;
}
async function listen(server: Server | HttpServer) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
}
async function close(server: Server | HttpServer | undefined) {
  if (server?.listening)
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
}
