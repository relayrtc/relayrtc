import { createHash, createHmac } from "node:crypto";
import type { StreamingConfig } from "./config.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Uint8Array, value: string) =>
  createHmac("sha256", key).update(value).digest();
const encode = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export const MAX_MEDIA_OBJECT = 16 * 1024 * 1024;
export async function boundedBody(response: Response, limit = MAX_MEDIA_OBJECT): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("STREAM_OBJECT_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > limit) throw new Error("STREAM_OBJECT_TOO_LARGE");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

// Path-style SigV4 keeps this adapter compatible with private MinIO and S3 buckets.
// Only API processes hold bucket credentials. Workers request fenced archive operations.
export class StreamingStore {
  constructor(private readonly config: StreamingConfig) {}
  async request(method: "PUT" | "GET" | "DELETE", key: string, body?: Buffer) {
    if (!/^streaming\/[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/u.test(key))
      throw new Error("INVALID_OBJECT_KEY");
    const cfg = this.config;
    const url = new URL(
      `/${encode(cfg.s3Bucket)}/${key.split("/").map(encode).join("/")}`,
      cfg.s3Endpoint,
    );
    const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const date = stamp.slice(0, 8),
      payloadHash = sha(body ?? "");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": stamp,
    };
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      url.pathname,
      "",
      names.map((n) => `${n}:${String(headers[n])}\n`).join(""),
      names.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date}/${cfg.s3Region}/s3/aws4_request`;
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${cfg.s3SecretKey}`, date), cfg.s3Region), "s3"),
      "aws4_request",
    );
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.s3AccessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(signingKey, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha(canonical)}`).toString("hex")}`;
    const response = await fetch(url, {
      method,
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok && !(method === "DELETE" && response.status === 404)) {
      await response.body?.cancel();
      throw new Error(`STORAGE_HTTP_${String(response.status)}`);
    }
    return response;
  }
  async put(key: string, body: Buffer) {
    const response = await this.request("PUT", key, body);
    await response.body?.cancel();
  }
  async get(key: string) {
    return boundedBody(await this.request("GET", key));
  }
  async remove(key: string) {
    const response = await this.request("DELETE", key);
    await response.body?.cancel();
  }
}
