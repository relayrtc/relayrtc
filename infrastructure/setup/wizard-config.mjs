import { randomUUID } from "node:crypto";
import { chown, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { configureEnvironmentText } from "../../scripts/configure-env.mjs";
import { prepareStreaming } from "../../scripts/prepare-streaming.mjs";
import { docker } from "./docker.mjs";
import { createManifest, prepareRuntimeFiles } from "./manifest.mjs";
import {
  assetDirectory,
  atomicWrite,
  readOptional,
  stateDirectory,
  updateEnvironment,
  version,
} from "./state.mjs";

const folderDirectory = join(stateDirectory, "relayrtc");
const environmentPath = join(folderDirectory, ".env");
const composePath = join(folderDirectory, "docker-compose.yml");
const metadataPath = join(folderDirectory, "wizard.json");

async function preserveHostOwnership() {
  const { uid, gid } = await stat(stateDirectory);
  let count = 0;
  const own = async (path, depth = 0) => {
    if (depth > 16 || ++count > 10000)
      throw new Error("The configuration folder contains too many entries");
    const item = await lstat(path);
    if (item.isSymbolicLink()) return;
    if (item.isDirectory())
      for (const file of await readdir(path)) await own(join(path, file), depth + 1);
    if (item.uid !== uid || item.gid !== gid) await chown(path, uid, gid);
  };
  await own(folderDirectory);
}

function text(value, name) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "'",
    )
  )
    throw new Error(`${name} must be a single-line value without quotes or control characters`);
  return value.trim();
}

function origin(value, name, protocols) {
  const url = new URL(text(value, name));
  if (
    !protocols.includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be an origin with the expected protocol and no path`);
  return url.origin;
}

function host(value, name) {
  const input = text(value, name);
  if (
    !input ||
    input.length > 253 ||
    (!isIP(input) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(input))
  )
    throw new Error(`${name} must be a hostname or IP address`);
  return input;
}

function number(value, name, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return String(result);
}

function provider(input, current, prefix) {
  if (!input || !["skip", "configure", "keep"].includes(input.mode))
    throw new Error(`Choose whether to configure or skip ${prefix}`);
  const names =
    prefix === "RESEND"
      ? ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]
      : [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`];
  if (input.mode === "keep") {
    if (!names.every((name) => current[name]?.trim()))
      throw new Error(`${prefix} is not already configured`);
    return {};
  }
  if (input.mode === "skip") return Object.fromEntries(names.map((name) => [name, ""]));
  const values = names.map((name, index) => text(index === 0 ? input.id : input.secret, name));
  if (values.some((value) => !value))
    throw new Error(`Provide both ${prefix} settings or choose Skip`);
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

export async function wizardState() {
  try {
    if ((await lstat(folderDirectory)).isSymbolicLink())
      throw new Error("Use a real relayrtc installation directory, not a symbolic link");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const existing = await readOptional(environmentPath);
  const metadataText = await readOptional(metadataPath);
  const metadata = metadataText ? JSON.parse(metadataText) : undefined;
  if (
    (existing || (await readOptional(composePath))) &&
    (!metadata || metadata.schema !== 1 || metadata.version !== version)
  )
    throw new Error(
      "This folder already contains another installation. Keep it intact and use a new empty relayrtc folder, or follow the documented migration procedure.",
    );
  const values = existing ? parseEnv(existing) : {};
  return {
    version,
    configured: Boolean(metadata),
    emailConfigured: Boolean(values.RESEND_API_KEY),
    githubConfigured: Boolean(values.GITHUB_CLIENT_ID),
    googleConfigured: Boolean(values.GOOGLE_CLIENT_ID),
    settings: metadata
      ? {
          ...metadata.settings,
          consoleOrigin: values.BETTER_AUTH_URL,
          apiOrigin: values.STREAMING_PUBLIC_ORIGIN,
          signalingOrigin: values.STREAMING_GUEST_SIGNALING_URL?.replace(/\/v1\/connect$/, ""),
          mediaAddress: values.MEDIA_RTC_ANNOUNCED_ADDRESS,
          turnIp: values.TURN_PUBLIC_IP,
          turnPort: values.TURN_PORT || "3478",
          rtcPort: values.MEDIA_RTC_PORT || "40000",
          rtcMaxPort: values.MEDIA_RTC_MAX_PORT || "40003",
          mediaWorkers: values.MEDIA_WORKERS || "1",
          allowedOrigins: values.RELAYRTC_SIGNALING_ALLOWED_ORIGINS || "",
        }
      : {},
  };
}

function settingsFor(input, current) {
  if (!input || !["local", "public"].includes(input.mode))
    throw new Error("Choose local or public hosting");
  const local = input.mode === "local";
  const consoleOrigin = origin(
    input.consoleOrigin,
    "Console address",
    local ? ["http:", "https:"] : ["https:"],
  );
  const apiOrigin = origin(
    input.apiOrigin,
    "API address",
    local ? ["http:", "https:"] : ["https:"],
  );
  const signalingOrigin = origin(
    input.signalingOrigin,
    "Signaling address",
    local ? ["ws:", "wss:"] : ["wss:"],
  );
  if (
    local &&
    [consoleOrigin, apiOrigin, signalingOrigin].some(
      (value) => !["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname),
    )
  )
    throw new Error("Use localhost addresses for local hosting or select Public server");
  const mediaAddress = host(input.mediaAddress, "Media announced address");
  const turnIp = text(input.turnIp, "TURN public IP");
  if (!isIP(turnIp)) throw new Error("TURN public IP must be an IPv4 or IPv6 address");
  const rtcPort = number(input.rtcPort, "First mediasoup port", 1024, 65535);
  const rtcMaxPort = number(input.rtcMaxPort, "Last mediasoup port", Number(rtcPort), 65535);
  if (Number(rtcMaxPort) - Number(rtcPort) > 1023)
    throw new Error("Use at most 1024 mediasoup ports");
  const turnHost = isIP(turnIp) === 6 ? `[${turnIp}]` : turnIp;
  const turnPort = number(input.turnPort || current.TURN_PORT || "3478", "TURN port", 1024, 65535);
  const allowed = [
    consoleOrigin,
    ...text(input.allowedOrigins ?? "", "Allowed browser origins")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => origin(value, "Browser origin", ["http:", "https:"])),
  ];
  const settings = {
    RELAYRTC_VERSION: version,
    BETTER_AUTH_URL: consoleOrigin,
    BETTER_AUTH_TRUSTED_ORIGINS: consoleOrigin,
    RELAYRTC_SIGNALING_ALLOWED_ORIGINS: [...new Set(allowed)].join(","),
    MEDIA_RTC_ANNOUNCED_ADDRESS: mediaAddress,
    MEDIA_RTC_PORT: rtcPort,
    MEDIA_RTC_MAX_PORT: rtcMaxPort,
    MEDIA_WORKERS: number(input.mediaWorkers, "mediasoup workers", 1, 16),
    TURN_PUBLIC_IP: turnIp,
    TURN_PORT: turnPort,
    TURN_STUN_URLS: `stun:${turnHost}:${turnPort}`,
    TURN_URLS: `turn:${turnHost}:${turnPort}?transport=udp,turn:${turnHost}:${turnPort}?transport=tcp`,
    STREAMING_PUBLIC_ORIGIN: apiOrigin,
    STREAMING_GUEST_SIGNALING_URL: `${signalingOrigin}/v1/connect`,
    STREAMING_PUBLIC_RTMP_ORIGIN: `rtmp://${isIP(mediaAddress) === 6 ? `[${mediaAddress}]` : mediaAddress}:1935`,
    STREAMING_ALLOWED_ORIGINS: [...new Set(allowed)].join(","),
    STREAMING_INGEST_BIND: local ? "127.0.0.1" : "0.0.0.0",
    STREAMING_WEBRTC_HOSTS: mediaAddress,
    ...provider(input.email, current, "RESEND"),
    ...provider(input.github, current, "GITHUB"),
    ...provider(input.google, current, "GOOGLE"),
  };
  settings.SKIP_EMAIL_VERIFICATION =
    (settings.RESEND_API_KEY ?? current.RESEND_API_KEY) ? "false" : "true";
  const templatePorts = { CONSOLE_PORT: "3002", API_PORT: "8080", SIGNALING_PORT: "8081" };
  if (local) {
    for (const [name, address] of [
      ["CONSOLE_PORT", consoleOrigin],
      ["API_PORT", apiOrigin],
      ["SIGNALING_PORT", signalingOrigin],
    ]) {
      const url = new URL(address);
      settings[name] = url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80");
    }
  } else Object.assign(settings, templatePorts);
  const ports = [
    settings.CONSOLE_PORT,
    settings.API_PORT,
    settings.SIGNALING_PORT,
    current.POSTGRES_PORT || "5433",
    current.MEDIA_PORT || "8083",
    current.GRAFANA_PORT || "3000",
    current.PROMETHEUS_PORT || "9090",
    "1935",
    "1936",
    turnPort,
    current.TURN_TLS_PORT || "5349",
  ];
  if (new Set(ports).size !== ports.length)
    throw new Error(
      "Console, API and signaling ports must be distinct from each other and the stack's reserved ports",
    );
  const first = Number(rtcPort);
  const last = Number(rtcMaxPort);
  if (
    [...ports, "8189"].some((value) => Number(value) >= first && Number(value) <= last) ||
    (first <= Number(current.RTC_MAX_PORT || "49200") &&
      last >= Number(current.RTC_MIN_PORT || "49160"))
  )
    throw new Error(
      "The mediasoup port range overlaps another stack service or the TURN relay range",
    );
  return settings;
}

export async function generateInstallation(input, signal) {
  await wizardState();
  const existing = await readOptional(environmentPath);
  if (!existing) {
    for (const kind of ["container", "volume"]) {
      const ids = await docker(
        [
          kind,
          "ls",
          "-q",
          ...(kind === "container" ? ["-a"] : []),
          "--filter",
          "label=com.docker.compose.project=relayrtc",
        ],
        { capture: true, signal },
      );
      if (ids.trim())
        throw new Error(
          "A relayrtc Docker project already exists. Keep its original configuration and data. Use the original installation folder instead of generating new secrets.",
        );
    }
  }
  const current = existing ? parseEnv(existing) : {};
  const settings = settingsFor(input, current);
  const template = await readFile(join(assetDirectory, ".env.example"), "utf8");
  const prepared = configureEnvironmentText(
    template,
    updateEnvironment(existing ?? template, settings),
    await readFile(
      join(assetDirectory, "infrastructure/configuration/streaming.env.example"),
      "utf8",
    ),
  );
  if (existing) {
    const generated = parseEnv(prepared.text);
    const credentials = [
      "POSTGRES_PASSWORD",
      "BETTER_AUTH_SECRET",
      "PARTICIPANT_TOKEN_SIGNING_SECRET",
      "RELAYRTC_INTERNAL_SECRET",
      "TURN_SHARED_SECRET",
      "GRAFANA_ADMIN_PASSWORD",
      "WEBHOOK_SIGNING_ENCRYPTION_KEY",
      "STREAMING_SIGNING_SECRET",
      "STREAMING_WORKER_KEY",
      "STREAMING_GATEWAY_KEY",
      "STREAMING_DESTINATION_ENCRYPTION_KEY",
      "STREAMING_S3_ACCESS_KEY",
      "STREAMING_S3_SECRET_KEY",
      "STREAMING_STORAGE_ROOT_USER",
      "STREAMING_STORAGE_ROOT_PASSWORD",
    ];
    if (credentials.some((name) => !current[name] || current[name] !== generated[name]))
      throw new Error(
        "Existing infrastructure credentials are missing or invalid. Restore the original .env before continuing. The wizard does not rotate initialized credentials.",
      );
  }
  const oldCompose = await readOptional(composePath);
  const oldMetadata = await readOptional(metadataPath);
  await mkdir(folderDirectory, { recursive: true, mode: 0o700 });
  const backup = join(folderDirectory, "backups", randomUUID());
  await mkdir(backup, { recursive: true, mode: 0o700 });
  if (existing) await atomicWrite(join(backup, ".env"), existing);
  if (oldCompose) await atomicWrite(join(backup, "docker-compose.yml"), oldCompose);
  if (oldMetadata) await atomicWrite(join(backup, "wizard.json"), oldMetadata);
  let saved = false;
  try {
    await atomicWrite(environmentPath, prepared.text);
    await prepareStreaming(folderDirectory, parseEnv(prepared.text));
    await prepareRuntimeFiles(folderDirectory);
    const manifest = await createManifest({
      version,
      project: "relayrtc",
      signal,
      layout: "folder",
      registry: "relayrtc",
      directory: folderDirectory,
    });
    const pending = join(folderDirectory, "docker-compose.pending.json");
    await atomicWrite(pending, `${JSON.stringify(manifest, null, 2)}\n`);
    const { composeEnvironment } = await import("./manifest.mjs");
    await docker(
      [
        "compose",
        "--project-name",
        "relayrtc",
        "--env-file",
        environmentPath,
        "-f",
        pending,
        "config",
        "--quiet",
      ],
      { capture: true, environment: await composeEnvironment(folderDirectory), signal },
    );
    await atomicWrite(composePath, await readFile(pending));
    await atomicWrite(
      metadataPath,
      `${JSON.stringify({ schema: 1, version, settings: { mode: input.mode, consoleOrigin: settings.BETTER_AUTH_URL, apiOrigin: settings.STREAMING_PUBLIC_ORIGIN, signalingOrigin: settings.STREAMING_GUEST_SIGNALING_URL.replace(/\/v1\/connect$/, ""), mediaAddress: settings.MEDIA_RTC_ANNOUNCED_ADDRESS, turnIp: settings.TURN_PUBLIC_IP, rtcPort: settings.MEDIA_RTC_PORT, rtcMaxPort: settings.MEDIA_RTC_MAX_PORT, mediaWorkers: settings.MEDIA_WORKERS, allowedOrigins: settings.RELAYRTC_SIGNALING_ALLOWED_ORIGINS }, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    saved = true;
    await rm(pending, { force: true });
    return {
      version,
      consoleOrigin: settings.BETTER_AUTH_URL,
      emailEnabled: settings.SKIP_EMAIL_VERIFICATION === "false",
      commands: ["cd relayrtc", "docker compose up -d --remove-orphans"],
    };
  } finally {
    if (!saved) {
      for (const [path, value] of [
        [environmentPath, existing],
        [composePath, oldCompose],
        [metadataPath, oldMetadata],
      ]) {
        if (value === undefined) await rm(path, { force: true });
        else await atomicWrite(path, value);
      }
    }
    await preserveHostOwnership();
  }
}
