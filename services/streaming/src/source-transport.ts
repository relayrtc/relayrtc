import { request as httpRequest, createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { validateWebhookDestination } from "@relayrtc/protocol/webhook-security";

/** Only this transport can fetch remote media. FFmpeg sees opaque local resource IDs. */
export class SourceTransport {
  private readonly resources = new Map<string, string>();
  private server: Server | undefined;
  private concurrent = 0;
  private requests = 0;
  private windowStart = Date.now();
  private windowBytes = 0;
  bytes = 0;
  private failure: Error | undefined;
  constructor(
    private readonly endpoint: string,
    private readonly authorization: string,
    private readonly allowedHosts: readonly string[],
    private readonly maxBytes: number,
    private readonly signal: AbortSignal,
  ) {}
  private checkedUrl(value: string) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      /^\/v1\/(?:playback|assets|ingest)(?:\/|$)/u.test(url.pathname) ||
      ![80, 443].includes(Number(url.port || (url.protocol === "https:" ? 443 : 80))) ||
      !this.allowedHosts.includes(url.hostname.toLowerCase()) ||
      value.length > 2048
    )
      throw new Error("SOURCE_ADDRESS_REJECTED");
    return url;
  }
  private resource(value: string, extension: "m3u8" | "mp4" | "ts" = "m3u8") {
    const url = this.checkedUrl(value);
    const key = createHash("sha256").update(url.href).digest("hex") + "." + extension;
    if (!this.resources.has(key) && this.resources.size >= 4096)
      throw new Error("SOURCE_RESOURCE_LIMIT");
    this.resources.set(key, url.href);
    return key;
  }
  async start() {
    const root = this.resource(this.endpoint);
    this.server = createServer((request, response) => {
      void (async () => {
        if (
          request.method !== "GET" ||
          this.failure ||
          this.concurrent >= 4 ||
          !/^\/[a-f0-9]{64}\.(?:m3u8|mp4|ts)$/u.test(request.url ?? "")
        )
          throw new Error("SOURCE_FETCH_LIMIT");
        const url = this.resources.get((request.url ?? "").slice(1));
        if (!url) throw new Error("SOURCE_RESOURCE_REJECTED");
        this.concurrent++;
        try {
          const body = await this.read(url, 0, url === new URL(this.endpoint).href);
          response.writeHead(200, {
            "content-type": body.manifest
              ? "application/vnd.apple.mpegurl"
              : "application/octet-stream",
            "content-length": body.bytes.length,
          });
          response.end(body.bytes);
        } finally {
          this.concurrent--;
        }
      })().catch((error: unknown) => {
        this.failure = new Error(
          error instanceof Error && error.message === "SOURCE_PROFILE_UNSUPPORTED"
            ? "SOURCE_PROFILE_UNSUPPORTED"
            : "SOURCE_FETCH_FAILED",
        );
        response.writeHead(502);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error("SOURCE_BRIDGE_FAILED"));
        return;
      }
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("SOURCE_BRIDGE_FAILED");
    return { url: `http://127.0.0.1:${String(address.port)}/${root}`, port: address.port };
  }
  private async read(
    value: string,
    redirects = 0,
    requireManifest = false,
  ): Promise<{ bytes: Buffer; manifest: boolean }> {
    this.signal.throwIfAborted();
    this.checkedUrl(value);
    if (Date.now() - this.windowStart >= 1000) {
      this.windowStart = Date.now();
      this.windowBytes = 0;
      this.requests = 0;
    }
    if (++this.requests > 100) throw new Error("SOURCE_FETCH_LIMIT");
    const target = await validateWebhookDestination(value);
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(10000)]);
    const result = await new Promise<{
      bytes: Buffer;
      type: string;
      location?: string;
      status: number;
    }>((resolve, reject) => {
      const req = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          hostname: target.address.address,
          family: target.address.family,
          port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
          servername: isIP(target.hostname) ? "" : target.hostname,
          method: "GET",
          path: target.url.pathname + target.url.search,
          agent: false,
          signal,
          maxHeaderSize: 16384,
          headers: {
            host: target.url.host,
            "accept-encoding": "identity",
            ...(new URL(value).origin === new URL(this.endpoint).origin && this.authorization
              ? { authorization: this.authorization }
              : {}),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            resolve({
              bytes: Buffer.alloc(0),
              status,
              type: "",
              ...(res.headers.location ? { location: res.headers.location } : {}),
            });
            return;
          }
          if (
            status !== 200 ||
            (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
          ) {
            res.destroy();
            reject(new Error("SOURCE_HTTP_FAILED"));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            this.bytes += chunk.length;
            this.windowBytes += chunk.length;
            if (size > 16777216 || this.bytes > this.maxBytes || this.windowBytes > 8388608) {
              res.destroy(new Error("SOURCE_BYTE_LIMIT"));
              return;
            }
            chunks.push(chunk);
          });
          res.once("error", reject);
          res.once("end", () => {
            resolve({
              bytes: Buffer.concat(chunks),
              status,
              type: res.headers["content-type"] ?? "",
            });
          });
        },
      );
      req.once("error", reject);
      req.end();
    });
    if (result.location) {
      if (redirects >= 3) throw new Error("SOURCE_REDIRECT_LIMIT");
      const next = new URL(result.location, value);
      if (new URL(value).protocol === "https:" && next.protocol !== "https:")
        throw new Error("SOURCE_TLS_REQUIRED");
      return this.read(next.href, redirects + 1, requireManifest);
    }
    if (result.status !== 200) throw new Error("SOURCE_HTTP_FAILED");
    const manifest = result.bytes.subarray(0, 7).toString() === "#EXTM3U";
    if (!manifest && /mpegurl/iu.test(result.type)) throw new Error("SOURCE_MANIFEST_INVALID");
    if (!manifest) {
      if (requireManifest) throw new Error("SOURCE_MANIFEST_REQUIRED");
      return { bytes: result.bytes, manifest: false };
    }
    if (result.bytes.length > 262144) throw new Error("SOURCE_MANIFEST_LIMIT");
    const lines = result.bytes.toString("utf8").split(/\r?\n/u);
    if (lines.length > 2000) throw new Error("SOURCE_MANIFEST_LIMIT");
    const master = lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"));
    const mediaExtension = lines.some((line) => line.startsWith("#EXT-X-MAP:")) ? "mp4" : "ts";
    const rewritten = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("#")) {
        // Reject encryption, variable substitution and unsupported URL-bearing extensions.
        if (trimmed.includes("BYTERANGE=")) throw new Error("SOURCE_PROFILE_UNSUPPORTED");
        if (
          /^#EXT-X-(?:KEY|SESSION-KEY|BYTERANGE|DEFINE|CONTENT-STEERING|SESSION-DATA|PRELOAD-HINT|PART|RENDITION-REPORT|I-FRAME-STREAM-INF)/u.test(
            trimmed,
          )
        )
          throw new Error("SOURCE_PROFILE_UNSUPPORTED");
        if (trimmed.includes("URI=") && !/^#EXT-X-(?:MAP|MEDIA):/u.test(trimmed))
          throw new Error("SOURCE_MANIFEST_INVALID");
        return trimmed.replace(
          /URI="([^"]+)"/gu,
          (_match, uri: string) =>
            `URI="/${this.resource(new URL(uri, value).href, trimmed.startsWith("#EXT-X-MAP:") ? "mp4" : "m3u8")}"`,
        );
      }
      return `/${this.resource(new URL(trimmed, value).href, master ? "m3u8" : mediaExtension)}`;
    });
    return { bytes: Buffer.from(rewritten.join("\n")), manifest: true };
  }
  getFailure() {
    return this.failure;
  }
  assertHealthy() {
    if (this.failure) throw this.failure;
  }
  async close() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (this.server)
        this.server.close(() => {
          resolve();
        });
      else resolve();
    });
    this.resources.clear();
  }
}
