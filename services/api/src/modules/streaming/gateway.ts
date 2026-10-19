import { signStreamingGrant } from "@relayrtc/protocol/streaming-control";
import type { StreamingConfig } from "./config.js";
import { boundedBody } from "./store.js";

export const ingestPath = (streamId: string) => `ingest_${streamId}`;
export const programPath = (sessionId: string, generation: number) =>
  `program_${sessionId}_${String(generation)}`;
export class StreamingGateway {
  constructor(readonly config: StreamingConfig) {}
  async control(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown> | null> {
    const token = signStreamingGrant(this.config.secret, {
      aud: "streaming-gateway",
      sub: "api",
      streamId: "",
      sessionId: "",
      generation: 0,
      action: "api",
    });
    const response = await fetch(`${this.config.gatewayApi}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GATEWAY_HTTP_${String(response.status)}`);
    }
    const bytes = await boundedBody(response, 1024 * 1024);
    return bytes.length ? (JSON.parse(bytes.toString()) as Record<string, unknown>) : {};
  }
  async ensurePath(path: string) {
    const exists = await this.control(`/v3/config/paths/get/${path}`);
    if (!exists) {
      try {
        await this.control(`/v3/config/paths/add/${path}`, "POST", {
          source: "publisher",
          overridePublisher: false,
        });
      } catch (error) {
        if (!(await this.control(`/v3/config/paths/get/${path}`))) throw error;
      }
    }
  }
  async removePath(path: string) {
    await this.control(`/v3/config/paths/delete/${path}`, "DELETE");
  }
  async kick(type: string, id: string) {
    const group: Record<string, string> = {
      rtmpConn: "rtmpconns",
      rtmpsConn: "rtmpsconns",
      webRTCSession: "webrtcsessions",
      rtspSession: "rtspsessions",
    };
    if (!group[type] || !/^[a-f0-9-]{36}$/iu.test(id)) return;
    await this.control(`/v3/${group[type]}/kick/${id}`, "POST");
    if (type === "rtmpConn") await this.control(`/v3/rtmpsconns/kick/${id}`, "POST");
  }
  async path(path: string) {
    return this.control(`/v3/paths/get/${path}`);
  }
}
