import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { docker } from "./docker.mjs";
import { assetDirectory, atomicWrite, stateDirectory } from "./state.mjs";

const files = [
  "docker-compose.yml",
  "docker-compose.streaming.yml",
  "docker-compose.release.yml",
  "docker-compose.streaming.release.yml",
];
const configurationTarget = "/run/relayrtc-monitoring";
const gatewayTarget = "/etc/relayrtc-streaming";

export async function composeEnvironment() {
  const text = await Promise.all(
    [
      ".env.example",
      "infrastructure/configuration/streaming.env.example",
      "infrastructure/configuration/advanced.env.example",
    ].map((file) => readFile(join(assetDirectory, file), "utf8")),
  );
  const current = await readFile(join(stateDirectory, ".env"), "utf8");
  const excluded = new Set(Object.keys(parseEnv(`${text.join("\n")}\n${current}`)));
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !excluded.has(name) && !name.startsWith("COMPOSE_"),
    ),
  );
}

export async function prepareRuntimeFiles() {
  const monitoring = join(stateDirectory, "runtime/monitoring");
  const streaming = join(stateDirectory, "runtime/streaming");
  for (const path of [monitoring, streaming, join(streaming, "certs")]) {
    await mkdir(path, { recursive: true, mode: 0o755 });
    await chmod(path, 0o755);
  }
  const values = parseEnv(await readFile(join(stateDirectory, ".env"), "utf8"));
  const configuration = (
    await readFile(join(assetDirectory, "infrastructure/prometheus/streaming.yml"), "utf8")
  )
    .replaceAll("/etc/prometheus/streaming.rules.yml", `${configurationTarget}/streaming.rules.yml`)
    .replaceAll("/run/secrets/streaming-worker-key", `${configurationTarget}/worker-key`)
    .replaceAll("/run/secrets/streaming-gateway-key", `${configurationTarget}/gateway-key`);
  await atomicWrite(join(monitoring, "prometheus.yml"), configuration, 0o644);
  await atomicWrite(
    join(monitoring, "streaming.rules.yml"),
    await readFile(join(assetDirectory, "infrastructure/prometheus/streaming.rules.yml")),
    0o644,
  );
  await atomicWrite(join(monitoring, "worker-key"), values.STREAMING_WORKER_KEY, 0o644);
  await atomicWrite(join(monitoring, "gateway-key"), values.STREAMING_GATEWAY_KEY, 0o644);
  const gateway = (
    await readFile(join(assetDirectory, "infrastructure/streaming/mediamtx.yml"), "utf8")
  ).replaceAll("/certs/", `${gatewayTarget}/certs/`);
  await atomicWrite(join(streaming, "mediamtx.yml"), gateway, 0o644);
}

export async function createManifest({ volume, version, project, signal }) {
  const output = await docker(
    [
      "compose",
      "--project-directory",
      assetDirectory,
      "--env-file",
      join(stateDirectory, ".env"),
      "--project-name",
      project,
      ...files.flatMap((file) => ["-f", join(assetDirectory, file)]),
      "config",
      "--no-interpolate",
      "--format",
      "json",
    ],
    { capture: true, environment: await composeEnvironment(), signal },
  );
  const values = parseEnv(await readFile(join(stateDirectory, ".env"), "utf8"));
  const resolveValue = (value) => {
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveValue(item)]),
      );
    if (typeof value !== "string") return value;
    return value.replace(
      /\$\$|\$\{([A-Z][A-Z0-9_]*)(?:(:-|:\?|-|\?)([^}]*))?\}/g,
      (match, name, operation, fallback) => {
        if (match === "$$") return "$";
        const present = Object.hasOwn(values, name);
        const nonempty = present && values[name] !== "";
        if ((operation === ":?" && !nonempty) || (operation === "?" && !present))
          throw new Error(`Required setting ${name} is missing`);
        if ((operation === ":-" && !nonempty) || (operation === "-" && !present))
          return fallback ?? "";
        return values[name] ?? "";
      },
    );
  };
  const manifest = resolveValue(JSON.parse(output));
  if (Object.keys(manifest.services ?? {}).length !== 16)
    throw new Error("The bundled release must contain the complete rooms and streaming stack");
  manifest.name = project;
  manifest.volumes["installation-config"] = { external: true, name: volume };
  for (const [name, service] of Object.entries(manifest.services)) {
    if (
      !service.image ||
      (service.image.startsWith("ghcr.io/relayrtc/") && !service.image.endsWith(`:${version}`))
    ) {
      throw new Error(`The bundled image for ${name} does not match the installer release`);
    }
    delete service.build;
    service.labels = {
      ...service.labels,
      "io.relayrtc.installation.config-volume": volume,
      "io.relayrtc.installation.version": version,
    };
    if (name === "streaming-gateway" || name === "prometheus") {
      service.volumes = (service.volumes ?? []).filter((item) => item.type !== "bind");
      service.volumes.push({
        type: "volume",
        source: "installation-config",
        read_only: true,
        target: name === "prometheus" ? configurationTarget : gatewayTarget,
        volume: {
          nocopy: true,
          subpath: `runtime/${name === "prometheus" ? "monitoring" : "streaming"}`,
        },
      });
      if (name === "prometheus")
        service.command = service.command.map((argument) =>
          argument.startsWith("--config.file=")
            ? `--config.file=${configurationTarget}/prometheus.yml`
            : argument,
        );
      else service.command = [`${gatewayTarget}/mediamtx.yml`];
    }
    if ((service.volumes ?? []).some((item) => item.type === "bind"))
      throw new Error(`Service ${name} still requires a host configuration path`);
    if (service.env_file || service.configs || service.secrets)
      throw new Error(`Service ${name} requires an unsupported external configuration source`);
  }
  if (manifest.services.api.environment.RELAYRTC_STREAMING_ENABLED !== "true")
    throw new Error("Streaming must be enabled in the standard installation");
  return manifest;
}

export async function compose(manifestPath, project, args, { signal, capture = false } = {}) {
  return docker(
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      join(stateDirectory, ".env"),
      "-f",
      manifestPath,
      ...args,
    ],
    { signal, capture, environment: await composeEnvironment() },
  );
}

export function encodeManifest(manifest) {
  const escape = (value) => {
    if (typeof value === "string") return value.replaceAll("$", () => "$$");
    if (Array.isArray(value)) return value.map(escape);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, escape(item)]));
    return value;
  };
  return `${JSON.stringify(escape(manifest), null, 2)}\n`;
}
