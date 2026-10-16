import { isIP } from "node:net";
import { z } from "zod";

const httpOrigin = z.url().refine((value) => {
  const u = new URL(value);
  return (
    ["http:", "https:"].includes(u.protocol) &&
    !u.username &&
    !u.password &&
    u.pathname === "/" &&
    !u.search &&
    !u.hash
  );
});
const configSchema = z.object({
  secret: z.string().min(32),
  workerKey: z.string().min(32),
  gatewayKey: z.string().min(32),
  publicOrigin: httpOrigin,
  gatewayApi: httpOrigin,
  gatewayWhip: httpOrigin,
  gatewayHls: httpOrigin,
  gatewayRtsp: z.url().refine((v) => {
    const u = new URL(v);
    return (
      u.protocol === "rtsp:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      ["", "/"].includes(u.pathname)
    );
  }),
  publicRtmp: z.url().refine((v) => {
    const u = new URL(v);
    return (
      ["rtmp:", "rtmps:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      ["", "/"].includes(u.pathname)
    );
  }),
  workerRtpIp: z.string().refine((v) => isIP(v) === 4),
  s3Endpoint: httpOrigin,
  s3Region: z.string().min(1).default("us-east-1"),
  s3Bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
  s3AccessKey: z.string().min(1),
  s3SecretKey: z.string().min(1),
  allowedOrigins: z.array(httpOrigin).default([]),
  maxSessions: z.coerce.number().int().min(1).max(100).default(8),
  maxStreamsPerEnvironment: z.coerce.number().int().min(1).max(1000).default(100),
});
export type StreamingConfig = z.infer<typeof configSchema>;
export function readStreamingConfig(
  env: Readonly<Record<string, string | undefined>>,
): StreamingConfig | undefined {
  if (env.RELAYRTC_STREAMING_ENABLED !== "true") return undefined;
  const value = configSchema.safeParse({
    secret: env.STREAMING_SIGNING_SECRET,
    workerKey: env.STREAMING_WORKER_KEY,
    gatewayKey: env.STREAMING_GATEWAY_KEY,
    publicOrigin: env.STREAMING_PUBLIC_ORIGIN,
    gatewayApi: env.STREAMING_GATEWAY_API_ORIGIN,
    gatewayWhip: env.STREAMING_GATEWAY_WHIP_ORIGIN,
    gatewayHls: env.STREAMING_GATEWAY_HLS_ORIGIN,
    gatewayRtsp: env.STREAMING_GATEWAY_RTSP_ORIGIN,
    publicRtmp: env.STREAMING_PUBLIC_RTMP_ORIGIN,
    workerRtpIp: env.STREAMING_WORKER_RTP_IP,
    s3Endpoint: env.STREAMING_S3_ENDPOINT,
    s3Region: env.STREAMING_S3_REGION,
    s3Bucket: env.STREAMING_S3_BUCKET,
    s3AccessKey: env.STREAMING_S3_ACCESS_KEY,
    s3SecretKey: env.STREAMING_S3_SECRET_KEY,
    allowedOrigins: env.STREAMING_ALLOWED_ORIGINS?.split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    maxSessions: env.STREAMING_MAX_SESSIONS,
    maxStreamsPerEnvironment: env.STREAMING_MAX_STREAMS_PER_ENVIRONMENT,
  });
  if (!value.success)
    throw new Error(
      `Invalid streaming configuration: ${value.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  if (new Set([value.data.secret, value.data.workerKey, value.data.gatewayKey]).size !== 3)
    throw new Error("Streaming signing, worker and gateway credentials must be distinct");
  return value.data;
}
