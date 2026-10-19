import { enforceCredentialPolicy, readInternalSecret } from "@relayrtc/protocol/credential-policy";
import { z } from "zod";
import { isIP } from "node:net";

export type MediaEnvironmentSource = Readonly<Record<string, string | undefined>>;

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const environmentSchema = z
  .object({
    DATABASE_URL: z
      .url()
      .default("postgresql://relaykit:relaykit@127.0.0.1:5432/relaykit")
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "postgres:" || protocol === "postgresql:";
      }, "Database URL must use PostgreSQL"),
    MEDIA_HOST: z.string().trim().min(1).default("0.0.0.0"),
    MEDIA_LOG_LEVEL: z.enum(logLevels).default("info"),
    MEDIA_MAX_ROOMS_PER_WORKER: z.coerce.number().int().min(1).max(10_000).default(100),
    MEDIA_MAX_TRANSPORTS_PER_ROOM: z.coerce.number().int().min(1).max(10_000).default(200),
    MEDIA_MAX_PRODUCERS_PER_ROOM: z.coerce.number().int().min(1).max(10000).default(100),
    MEDIA_MAX_CONSUMERS_PER_ROOM: z.coerce.number().int().min(1).max(10000).default(600),
    MEDIA_MAX_TRANSPORTS_PER_PARTICIPANT: z.coerce.number().int().min(1).max(10000).default(4),
    MEDIA_MAX_PRODUCERS_PER_PARTICIPANT: z.coerce.number().int().min(1).max(10000).default(4),
    MEDIA_MAX_CONSUMERS_PER_PARTICIPANT: z.coerce.number().int().min(1).max(10000).default(128),
    MEDIA_NODE_ID: z.string().trim().min(1).max(128).default("media-local"),
    MEDIA_PORT: z.coerce.number().int().min(1).max(65_535).default(8082),
    MEDIA_RTC_ANNOUNCED_ADDRESS: z.string().trim().min(1).default("127.0.0.1"),
    MEDIA_RTC_ADDITIONAL_ANNOUNCED_ADDRESSES: z
      .string()
      .default("")
      .refine((value) => {
        const addresses = value
          .split(",")
          .map((address) => address.trim())
          .filter(Boolean);
        return (
          addresses.length <= 8 &&
          addresses.every(
            (address) => isIP(address) !== 0 && address !== "0.0.0.0" && address !== "::",
          )
        );
      }, "Provide at most eight concrete IPv4 or IPv6 addresses"),
    MEDIA_RTC_LISTEN_IP: z.string().trim().min(1).default("0.0.0.0"),
    MEDIA_RTC_MAX_PORT: z.coerce.number().int().min(1).max(65_535).default(40_003),
    MEDIA_RTC_PORT: z.coerce.number().int().min(1).max(65_535).default(40_000),
    MEDIA_WORKERS: z.coerce.number().int().min(1).max(128).default(1),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    RELAYRTC_INTERNAL_SECRET: z.string().min(32).default("development-internal-secret-change-me"),
    RELAYRTC_SIGNALING_INTERNAL_URL: z.url().default("http://signaling:8081/internal/v1"),
  })
  .strict()
  .refine((value) => value.MEDIA_RTC_PORT + value.MEDIA_WORKERS - 1 <= value.MEDIA_RTC_MAX_PORT, {
    message: "RTC port range must provide one port per media worker",
    path: ["MEDIA_RTC_MAX_PORT"],
  });

export interface MediaConfig {
  databaseUrl: string;
  host: string;
  logLevel: (typeof logLevels)[number];
  maxProducersPerRoom?: number;
  maxConsumersPerRoom?: number;
  maxTransportsPerParticipant?: number;
  maxProducersPerParticipant?: number;
  maxConsumersPerParticipant?: number;
  maxRoomsPerWorker: number;
  maxTransportsPerRoom: number;
  nodeEnvironment: "development" | "test" | "production";
  nodeId: string;
  internalSecret: string;
  port: number;
  rtcAnnouncedAddress: string;
  rtcAdditionalAnnouncedAddresses?: readonly string[];
  rtcListenIp: string;
  rtcMaxPort: number;
  rtcPort: number;
  workerCount: number;
  signalingInternalUrl: string;
}

export const readMediaEnvironment = (source: MediaEnvironmentSource): MediaConfig => {
  enforceCredentialPolicy(source, [
    "DATABASE_URL",
    "RELAYRTC_INTERNAL_SECRET",
    "RELAYRTC_SIGNALING_INTERNAL_URL",
    "MEDIA_RTC_ANNOUNCED_ADDRESS",
  ]);
  const parsed = environmentSchema.safeParse({
    DATABASE_URL: source.DATABASE_URL,
    MEDIA_HOST: source.MEDIA_HOST,
    MEDIA_LOG_LEVEL: source.MEDIA_LOG_LEVEL,
    MEDIA_MAX_ROOMS_PER_WORKER: source.MEDIA_MAX_ROOMS_PER_WORKER,
    MEDIA_MAX_TRANSPORTS_PER_ROOM: source.MEDIA_MAX_TRANSPORTS_PER_ROOM,
    MEDIA_MAX_PRODUCERS_PER_ROOM: source.MEDIA_MAX_PRODUCERS_PER_ROOM,
    MEDIA_MAX_CONSUMERS_PER_ROOM: source.MEDIA_MAX_CONSUMERS_PER_ROOM,
    MEDIA_MAX_TRANSPORTS_PER_PARTICIPANT: source.MEDIA_MAX_TRANSPORTS_PER_PARTICIPANT,
    MEDIA_MAX_PRODUCERS_PER_PARTICIPANT: source.MEDIA_MAX_PRODUCERS_PER_PARTICIPANT,
    MEDIA_MAX_CONSUMERS_PER_PARTICIPANT: source.MEDIA_MAX_CONSUMERS_PER_PARTICIPANT,
    MEDIA_NODE_ID: source.MEDIA_NODE_ID,
    MEDIA_PORT: source.MEDIA_PORT,
    MEDIA_RTC_ANNOUNCED_ADDRESS: source.MEDIA_RTC_ANNOUNCED_ADDRESS,
    MEDIA_RTC_ADDITIONAL_ANNOUNCED_ADDRESSES: source.MEDIA_RTC_ADDITIONAL_ANNOUNCED_ADDRESSES,
    MEDIA_RTC_LISTEN_IP: source.MEDIA_RTC_LISTEN_IP,
    MEDIA_RTC_MAX_PORT: source.MEDIA_RTC_MAX_PORT,
    MEDIA_RTC_PORT: source.MEDIA_RTC_PORT,
    MEDIA_WORKERS: source.MEDIA_WORKERS,
    NODE_ENV: source.NODE_ENV,
    RELAYRTC_INTERNAL_SECRET: source.RELAYRTC_INTERNAL_SECRET,
    RELAYRTC_SIGNALING_INTERNAL_URL: source.RELAYRTC_SIGNALING_INTERNAL_URL,
  });

  if (!parsed.success) {
    const description = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid media service configuration: ${description}`);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    host: parsed.data.MEDIA_HOST,
    logLevel: parsed.data.MEDIA_LOG_LEVEL,
    ...(source.MEDIA_MAX_PRODUCERS_PER_ROOM === undefined
      ? {}
      : { maxProducersPerRoom: parsed.data.MEDIA_MAX_PRODUCERS_PER_ROOM }),
    ...(source.MEDIA_MAX_CONSUMERS_PER_ROOM === undefined
      ? {}
      : { maxConsumersPerRoom: parsed.data.MEDIA_MAX_CONSUMERS_PER_ROOM }),
    ...(source.MEDIA_MAX_TRANSPORTS_PER_PARTICIPANT === undefined
      ? {}
      : { maxTransportsPerParticipant: parsed.data.MEDIA_MAX_TRANSPORTS_PER_PARTICIPANT }),
    ...(source.MEDIA_MAX_PRODUCERS_PER_PARTICIPANT === undefined
      ? {}
      : { maxProducersPerParticipant: parsed.data.MEDIA_MAX_PRODUCERS_PER_PARTICIPANT }),
    ...(source.MEDIA_MAX_CONSUMERS_PER_PARTICIPANT === undefined
      ? {}
      : { maxConsumersPerParticipant: parsed.data.MEDIA_MAX_CONSUMERS_PER_PARTICIPANT }),
    maxRoomsPerWorker: parsed.data.MEDIA_MAX_ROOMS_PER_WORKER,
    maxTransportsPerRoom: parsed.data.MEDIA_MAX_TRANSPORTS_PER_ROOM,
    nodeEnvironment: parsed.data.NODE_ENV,
    nodeId: parsed.data.MEDIA_NODE_ID,
    internalSecret: readInternalSecret(source),
    port: parsed.data.MEDIA_PORT,
    rtcAnnouncedAddress: parsed.data.MEDIA_RTC_ANNOUNCED_ADDRESS,
    rtcAdditionalAnnouncedAddresses: [
      ...new Set(
        parsed.data.MEDIA_RTC_ADDITIONAL_ANNOUNCED_ADDRESSES.split(",")
          .map((address) => address.trim())
          .filter(Boolean),
      ),
    ],
    rtcListenIp: parsed.data.MEDIA_RTC_LISTEN_IP,
    rtcMaxPort: parsed.data.MEDIA_RTC_MAX_PORT,
    rtcPort: parsed.data.MEDIA_RTC_PORT,
    workerCount: parsed.data.MEDIA_WORKERS,
    signalingInternalUrl: parsed.data.RELAYRTC_SIGNALING_INTERNAL_URL,
  };
};
