import { readRequestLimits, type RequestLimits } from "../resource-limits.js";
import { isIP } from "node:net";
import { enforceCredentialPolicy, readInternalSecret } from "@relayrtc/protocol/credential-policy";
import { webhookEncryptionKeyValid } from "@relayrtc/protocol/webhook-security";
import { z } from "zod";
import { readStreamingConfig, type StreamingConfig } from "../modules/streaming/config.js";
import { readAuthEnvironment, type AuthEnvironment } from "@relayrtc/auth/server";

export type ApiEnvironmentSource = Readonly<Record<string, string | undefined>>;

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const iceUrls = (protocols: readonly string[]) =>
  z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1))
    .refine(
      (values) =>
        values.every((value) => protocols.some((protocol) => value.startsWith(`${protocol}:`))),
      `URLs must use ${protocols.join(" or ")}`,
    );

const environmentSchema = z
  .object({
    API_HOST: z.string().trim().min(1).default("0.0.0.0"),
    API_LOG_LEVEL: z.enum(logLevels).default("info"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    BETTER_AUTH_SECRET: z.string().trim().min(32).optional(),
    BETTER_AUTH_URL: z.url().trim().optional(),
    API_TRUSTED_PROXY_CIDRS: z.string().default(""),
    API_TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    DATABASE_URL: z
      .string()
      .trim()
      .min(1)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "postgres:" || url.protocol === "postgresql:";
        } catch {
          return false;
        }
      }, "DATABASE_URL must be a valid PostgreSQL URL"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PARTICIPANT_TOKEN_AUDIENCE: z.string().trim().min(1).default("relayrtc-realtime"),
    PARTICIPANT_TOKEN_ISSUER: z.string().trim().min(1).default("relayrtc-api"),
    PARTICIPANT_TOKEN_KEY_ID: z.string().trim().min(1).max(128).default("participant-v1"),
    PARTICIPANT_TOKEN_SIGNING_SECRET: z.string().min(32),
    RELAYRTC_INTERNAL_SECRET: z.string().min(32).optional(),
    RELAYRTC_MEDIA_INTERNAL_URL: z.url().default("http://media:8082/internal/v1"),
    RELAYRTC_SIGNALING_INTERNAL_URL: z.url().default("http://signaling:8081/internal/v1"),
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
    TURN_ACCOUNTING_LOG_DIRECTORY: z.string().trim().min(1).optional(),
    TURN_ACCOUNTING_METRICS_URL: z.url().optional(),
    TURN_AUTH_MODE: z.enum(["rest", "managed"]).default("rest"),
    TURN_REALM: z
      .string()
      .trim()
      .min(1)
      .max(127)
      .regex(/^[A-Za-z0-9_.-]+$/u)
      .optional(),
    TURN_ADMIN_HOST: z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z0-9_.:\[\]-]+$/u)
      .optional(),
    TURN_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(5766),
    TURN_ADMIN_PASSWORD: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[\x21-\x7e]+$/u)
      .optional(),
    TURN_SHARED_SECRET: z.string().min(32),
    TURN_STUN_URLS: iceUrls(["stun", "stuns"]).default(["stun:localhost:3478"]),
    TURN_URLS: iceUrls(["turn", "turns"]).default([
      "turn:localhost:3478?transport=udp",
      "turn:localhost:3478?transport=tcp",
      "turns:localhost:5349?transport=tcp",
    ]),
    WEBHOOK_SIGNING_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(webhookEncryptionKeyValid, "Use a base64-encoded 32-byte encryption key")
        .optional(),
    ),
  })
  .strict();

export interface ApiConfig {
  streaming?: StreamingConfig;
  accountAuth?: AuthEnvironment;
  requestLimits?: RequestLimits;
  consoleAuth?: { baseUrl: string; secret: string };
  databaseUrl: string;
  host: string;
  logLevel: (typeof logLevels)[number];
  nodeEnvironment: "development" | "test" | "production";
  participantTokenAudience: string;
  participantTokenIssuer: string;
  participantTokenKeyId: string;
  participantTokenSigningSecret: string;
  internalSecret: string;
  mediaInternalUrl: string;
  port: number;
  signalingInternalUrl: string;
  trustProxy: false | string[];
  turnCredentialTtlSeconds: number;
  turnAccountingLogDirectory?: string;
  turnAccountingMetricsUrl?: string;
  turnManagedRealm?: string;
  turnAllocationControl?: { host: string; port: number; password: string };
  turnSharedSecret: string;
  turnStunUrls: readonly string[];
  turnUrls: readonly string[];
  webhookSigningEncryptionKey?: string;
}

export const readApiEnvironment = (source: ApiEnvironmentSource): ApiConfig => {
  const streaming = readStreamingConfig(source);
  enforceCredentialPolicy(source, [
    "DATABASE_URL",
    "RELAYRTC_INTERNAL_SECRET",
    "RELAYRTC_MEDIA_INTERNAL_URL",
    "RELAYRTC_SIGNALING_INTERNAL_URL",
    "TURN_STUN_URLS",
    "TURN_URLS",
  ]);
  const parsed = environmentSchema.safeParse({
    API_HOST: source.API_HOST,
    API_LOG_LEVEL: source.API_LOG_LEVEL,
    API_PORT: source.API_PORT,
    BETTER_AUTH_SECRET: source.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: source.BETTER_AUTH_URL,
    API_TRUST_PROXY: source.API_TRUST_PROXY,
    API_TRUSTED_PROXY_CIDRS: source.API_TRUSTED_PROXY_CIDRS,
    DATABASE_URL: source.DATABASE_URL,
    NODE_ENV: source.NODE_ENV,
    PARTICIPANT_TOKEN_AUDIENCE: source.PARTICIPANT_TOKEN_AUDIENCE,
    PARTICIPANT_TOKEN_ISSUER: source.PARTICIPANT_TOKEN_ISSUER,
    PARTICIPANT_TOKEN_KEY_ID: source.PARTICIPANT_TOKEN_KEY_ID,
    PARTICIPANT_TOKEN_SIGNING_SECRET: source.PARTICIPANT_TOKEN_SIGNING_SECRET,
    RELAYRTC_INTERNAL_SECRET: source.RELAYRTC_INTERNAL_SECRET,
    RELAYRTC_MEDIA_INTERNAL_URL: source.RELAYRTC_MEDIA_INTERNAL_URL,
    RELAYRTC_SIGNALING_INTERNAL_URL: source.RELAYRTC_SIGNALING_INTERNAL_URL,
    TURN_CREDENTIAL_TTL_SECONDS: source.TURN_CREDENTIAL_TTL_SECONDS,
    TURN_ACCOUNTING_LOG_DIRECTORY: source.TURN_ACCOUNTING_LOG_DIRECTORY,
    TURN_ACCOUNTING_METRICS_URL: source.TURN_ACCOUNTING_METRICS_URL,
    TURN_AUTH_MODE: source.TURN_AUTH_MODE,
    TURN_REALM: source.TURN_REALM,
    TURN_ADMIN_HOST: source.TURN_ADMIN_HOST,
    TURN_ADMIN_PORT: source.TURN_ADMIN_PORT,
    TURN_ADMIN_PASSWORD: source.TURN_ADMIN_PASSWORD,
    TURN_SHARED_SECRET: source.TURN_SHARED_SECRET,
    TURN_STUN_URLS: source.TURN_STUN_URLS,
    TURN_URLS: source.TURN_URLS,
    WEBHOOK_SIGNING_ENCRYPTION_KEY: source.WEBHOOK_SIGNING_ENCRYPTION_KEY,
  });

  if (!parsed.success) {
    const description = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid API configuration: ${description}`);
  }

  const authSecret = parsed.data.BETTER_AUTH_SECRET;
  if (
    parsed.data.TURN_AUTH_MODE === "managed" &&
    (!parsed.data.TURN_REALM ||
      !parsed.data.TURN_ADMIN_HOST ||
      !parsed.data.TURN_ADMIN_PASSWORD ||
      !parsed.data.TURN_ACCOUNTING_LOG_DIRECTORY)
  )
    throw new Error(
      "Managed TURN requires TURN_REALM, TURN_ADMIN_HOST, TURN_ADMIN_PASSWORD and TURN_ACCOUNTING_LOG_DIRECTORY",
    );
  const authUrl = parsed.data.BETTER_AUTH_URL;
  if ((authSecret === undefined) !== (authUrl === undefined)) {
    throw new Error("BETTER_AUTH_SECRET and BETTER_AUTH_URL must be configured together");
  }
  if (authUrl) {
    const url = new URL(authUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("BETTER_AUTH_URL must be an HTTP origin without credentials or a path");
    }
  }

  const trustedProxyCIDRs = parsed.data.API_TRUSTED_PROXY_CIDRS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const cidr of trustedProxyCIDRs) {
    const [address, bits, extra] = cidr.split("/");
    const family = address ? isIP(address) : 0;
    if (
      !family ||
      !bits ||
      !/^\d+$/u.test(bits) ||
      extra !== undefined ||
      Number(bits) < 1 ||
      Number(bits) > (family === 4 ? 32 : 128) ||
      address?.includes("%")
    ) {
      throw new Error("API_TRUSTED_PROXY_CIDRS must contain explicit IPv4 or IPv6 CIDRs");
    }
  }
  if (parsed.data.API_TRUST_PROXY && trustedProxyCIDRs.length === 0) {
    throw new Error("API_TRUSTED_PROXY_CIDRS is required when API_TRUST_PROXY is true");
  }
  return {
    ...(streaming ? { streaming } : {}),
    ...(source.RELAYRTC_ACCOUNT_API_ENABLED === "true"
      ? { accountAuth: readAuthEnvironment(source) }
      : {}),
    ...(authSecret && authUrl ? { consoleAuth: { baseUrl: authUrl, secret: authSecret } } : {}),
    ...([
      "API_REQUESTS_PER_NODE_PER_MINUTE",
      "API_REQUESTS_PER_IP_PER_MINUTE",
      "API_REQUESTS_PER_KEY_PER_MINUTE",
      "API_REQUESTS_PER_PROJECT_PER_MINUTE",
      "API_REQUESTS_PER_ROOM_PER_MINUTE",
      "API_LIMIT_TRACKED_SCOPES",
    ].some((key) => source[key] !== undefined)
      ? { requestLimits: readRequestLimits(source) }
      : {}),
    databaseUrl: parsed.data.DATABASE_URL,
    ...(parsed.data.WEBHOOK_SIGNING_ENCRYPTION_KEY
      ? { webhookSigningEncryptionKey: parsed.data.WEBHOOK_SIGNING_ENCRYPTION_KEY }
      : {}),
    host: parsed.data.API_HOST,
    logLevel: parsed.data.API_LOG_LEVEL,
    nodeEnvironment: parsed.data.NODE_ENV,
    participantTokenAudience: parsed.data.PARTICIPANT_TOKEN_AUDIENCE,
    participantTokenIssuer: parsed.data.PARTICIPANT_TOKEN_ISSUER,
    participantTokenKeyId: parsed.data.PARTICIPANT_TOKEN_KEY_ID,
    participantTokenSigningSecret: parsed.data.PARTICIPANT_TOKEN_SIGNING_SECRET,
    internalSecret: readInternalSecret(source),
    mediaInternalUrl: parsed.data.RELAYRTC_MEDIA_INTERNAL_URL,
    port: parsed.data.API_PORT,
    signalingInternalUrl: parsed.data.RELAYRTC_SIGNALING_INTERNAL_URL,
    trustProxy: parsed.data.API_TRUST_PROXY ? trustedProxyCIDRs : false,
    turnCredentialTtlSeconds: parsed.data.TURN_CREDENTIAL_TTL_SECONDS,
    ...(parsed.data.TURN_AUTH_MODE === "managed" &&
    parsed.data.TURN_REALM &&
    parsed.data.TURN_ADMIN_HOST &&
    parsed.data.TURN_ADMIN_PASSWORD
      ? {
          turnManagedRealm: parsed.data.TURN_REALM,
          turnAllocationControl: {
            host: parsed.data.TURN_ADMIN_HOST,
            port: parsed.data.TURN_ADMIN_PORT,
            password: parsed.data.TURN_ADMIN_PASSWORD,
          },
        }
      : {}),
    ...(parsed.data.TURN_ACCOUNTING_LOG_DIRECTORY
      ? { turnAccountingLogDirectory: parsed.data.TURN_ACCOUNTING_LOG_DIRECTORY }
      : {}),
    ...(parsed.data.TURN_ACCOUNTING_METRICS_URL
      ? { turnAccountingMetricsUrl: parsed.data.TURN_ACCOUNTING_METRICS_URL }
      : {}),
    turnSharedSecret: parsed.data.TURN_SHARED_SECRET,
    turnStunUrls: parsed.data.TURN_STUN_URLS,
    turnUrls: parsed.data.TURN_URLS,
  };
};
