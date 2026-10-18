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
  sourceAllowedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/u)).default([]),
  maxSourceJobs: z.coerce.number().int().min(1).max(100).default(4),
  maxSchedules: z.coerce.number().int().min(1).max(10000).default(1000),
  maxSchedulesPerEnvironment: z.coerce.number().int().min(1).max(1000).default(100),
  scheduleNotificationsEnabled: z.boolean().default(false),
  guestsEnabled: z.boolean().default(true),
  guestSignalingUrl: z
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        ["ws:", "wss:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash
      );
    })
    .default("ws://localhost:8081/v1/connect"),
  dvrEnabled: z.boolean().default(true),
  maxBuffersPerEnvironment: z.coerce.number().int().min(1).max(32).default(2),
  mixersEnabled: z.boolean().default(true),
  maxMixers: z.coerce.number().int().min(1).max(16).default(2),
  maxMixersPerEnvironment: z.coerce.number().int().min(1).max(8).default(1),
  maxClipJobs: z.coerce.number().int().min(1).max(32).default(4),
  maxClipsPerMinute: z.coerce.number().int().min(1).max(100).default(10),
  maxClipDurationSeconds: z.coerce.number().int().min(5).max(120).default(120),
  maxBuffers: z.coerce.number().int().min(1).max(32).default(4),
  maxRecordings: z.coerce.number().int().min(1).max(100).default(4),
  maxRecordingsPerEnvironment: z.coerce.number().int().min(1).max(20).default(2),
  maxRecordingBytes: z.coerce.number().int().min(16777216).max(1073741824).default(536870912),
  maxSessions: z.coerce.number().int().min(1).max(100).default(8),
  maxStreamsPerEnvironment: z.coerce.number().int().min(1).max(1000).default(100),
  broadcastsEnabled: z.boolean().default(true),
  destinationEncryptionKey: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/u)
    .optional(),
  maxDestinations: z.coerce.number().int().min(1).max(8).default(8),
  maxEgressBitrate: z.coerce.number().int().min(1000000).max(100000000).default(24000000),
  maxEgressBytes: z.coerce
    .number()
    .int()
    .min(1000000)
    .max(Number.MAX_SAFE_INTEGER)
    .default(20000000000),
  maxBroadcasts: z.coerce.number().int().min(1).max(1000).default(16),
  maxBroadcastsPerEnvironment: z.coerce.number().int().min(1).max(100).default(4),
  maxOutputJobs: z.coerce.number().int().min(1).max(100).default(16),
  maxOutputJobsPerWorker: z.coerce.number().int().min(1).max(16).default(4),
});
export type StreamingConfig = z.infer<typeof configSchema>;
export function readStreamingConfig(
  env: Readonly<Record<string, string | undefined>>,
): StreamingConfig | undefined {
  if (env.RELAYRTC_STREAMING_ENABLED !== "true") return undefined;
  if (
    env.STREAMING_GUESTS_ENABLED !== undefined &&
    !["true", "false"].includes(env.STREAMING_GUESTS_ENABLED)
  )
    throw new Error("STREAMING_GUESTS_ENABLED must be true or false");
  if (
    env.STREAMING_DVR_ENABLED !== undefined &&
    !["true", "false"].includes(env.STREAMING_DVR_ENABLED)
  )
    throw new Error("STREAMING_DVR_ENABLED must be true or false");
  if (
    env.STREAMING_BROADCASTS_ENABLED !== undefined &&
    !["true", "false"].includes(env.STREAMING_BROADCASTS_ENABLED)
  )
    throw new Error("STREAMING_BROADCASTS_ENABLED must be true or false");
  if (
    env.STREAMING_MIXERS_ENABLED !== undefined &&
    !["true", "false"].includes(env.STREAMING_MIXERS_ENABLED)
  )
    throw new Error("STREAMING_MIXERS_ENABLED must be true or false");
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
    sourceAllowedHosts: (env.STREAMING_SOURCE_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    maxSourceJobs: env.STREAMING_MAX_SOURCE_JOBS,
    maxSchedules: env.STREAMING_MAX_SCHEDULES,
    maxSchedulesPerEnvironment: env.STREAMING_MAX_SCHEDULES_PER_ENVIRONMENT,
    scheduleNotificationsEnabled: env.STREAMING_SCHEDULE_NOTIFICATIONS_ENABLED === "true",
    guestsEnabled: env.STREAMING_GUESTS_ENABLED !== "false",
    guestSignalingUrl: env.STREAMING_GUEST_SIGNALING_URL,
    dvrEnabled: env.STREAMING_DVR_ENABLED !== "false",
    maxBuffersPerEnvironment: env.STREAMING_MAX_BUFFERS_PER_ENVIRONMENT,
    mixersEnabled: env.STREAMING_MIXERS_ENABLED !== "false",
    maxMixers: env.STREAMING_MAX_MIXERS,
    maxMixersPerEnvironment: env.STREAMING_MAX_MIXERS_PER_ENVIRONMENT,
    maxClipJobs: env.STREAMING_MAX_CLIP_JOBS,
    maxClipsPerMinute: env.STREAMING_MAX_CLIPS_PER_MINUTE,
    maxClipDurationSeconds: env.STREAMING_MAX_CLIP_DURATION_SECONDS,
    maxBuffers: env.STREAMING_MAX_BUFFERS,
    maxRecordings: env.STREAMING_MAX_RECORDINGS,
    maxRecordingsPerEnvironment: env.STREAMING_MAX_RECORDINGS_PER_ENVIRONMENT,
    maxRecordingBytes: env.STREAMING_MAX_RECORDING_BYTES,
    maxSessions: env.STREAMING_MAX_SESSIONS,
    maxStreamsPerEnvironment: env.STREAMING_MAX_STREAMS_PER_ENVIRONMENT,
    broadcastsEnabled: env.STREAMING_BROADCASTS_ENABLED !== "false",
    destinationEncryptionKey:
      env.STREAMING_DESTINATION_ENCRYPTION_KEY === ""
        ? undefined
        : env.STREAMING_DESTINATION_ENCRYPTION_KEY,
    maxDestinations: env.STREAMING_MAX_DESTINATIONS,
    maxEgressBitrate: env.STREAMING_MAX_EGRESS_BITRATE,
    maxEgressBytes: env.STREAMING_MAX_EGRESS_BYTES,
    maxBroadcasts: env.STREAMING_MAX_BROADCASTS,
    maxBroadcastsPerEnvironment: env.STREAMING_MAX_BROADCASTS_PER_ENVIRONMENT,
    maxOutputJobs: env.STREAMING_MAX_OUTPUT_JOBS,
    maxOutputJobsPerWorker: env.STREAMING_MAX_OUTPUT_JOBS_PER_WORKER,
  });
  if (!value.success)
    throw new Error(
      `Invalid streaming configuration: ${value.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  if (new Set([value.data.secret, value.data.workerKey, value.data.gatewayKey]).size !== 3)
    throw new Error("Streaming signing, worker and gateway credentials must be distinct");
  if (
    value.data.destinationEncryptionKey &&
    [value.data.secret, value.data.workerKey, value.data.gatewayKey].includes(
      value.data.destinationEncryptionKey,
    )
  )
    throw new Error(
      "Destination encryption credentials must be separate from streaming control credentials",
    );
  return value.data;
}
