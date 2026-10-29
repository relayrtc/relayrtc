import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { prepareStreaming } from "../../scripts/prepare-streaming.mjs";
import { configureEnvironmentText } from "../../scripts/configure-env.mjs";
import { docker } from "./docker.mjs";
import { compose, createManifest, encodeManifest, prepareRuntimeFiles } from "./manifest.mjs";
import {
  assetDirectory,
  atomicWrite,
  lockState,
  readInput,
  readOptional,
  stateDirectory,
  updateEnvironment,
  version,
} from "./state.mjs";

const manifestPath = join(stateDirectory, "compose.json");
const metadataPath = join(stateDirectory, "installation.json");
const environmentPath = join(stateDirectory, ".env");
const controller = new AbortController();
const signal = controller.signal;
const commands = new Set([
  "install",
  "upgrade",
  "start",
  "stop",
  "status",
  "logs",
  "configure",
  "import-env",
  "export-env",
  "credentials",
  "help",
]);
const appServices = [
  "console",
  "api",
  "signaling",
  "media",
  "streaming-worker",
  "streaming-outputs",
  "streaming-sources",
  "streaming-recordings",
  "streaming-gateway",
];
const output = (message) => process.stdout.write(`${message}\n`);

function help() {
  output(
    "RelayRTC Docker setup\n\ninstall       Prepare and start the complete stack (default)\nstart         Start the saved installation\nstop          Stop application services, retaining database/storage/monitoring\nstatus        Show containers\nlogs          Show recent service logs\nconfigure     Merge dotenv settings from standard input without applying them\nimport-env    Import an existing installation's dotenv settings\nexport-env    Write the saved dotenv file to standard output (contains secrets)\ncredentials   Print the Grafana login (contains a password)\nupgrade       Explicitly upgrade after draining traffic and backing up data\n\nMount /var/run/docker.sock and a named volume at /setup/state. No browser setup page is required.",
  );
}

function validateSettings(values) {
  for (const name of ["GITHUB", "GOOGLE"]) {
    if (
      Boolean(values[`${name}_CLIENT_ID`]?.trim()) !==
      Boolean(values[`${name}_CLIENT_SECRET`]?.trim())
    ) {
      throw new Error(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be configured together`);
    }
  }
  const origin = new URL(values.BETTER_AUTH_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const email = Boolean(values.RESEND_API_KEY?.trim());
  if (email && !values.RESEND_FROM_EMAIL?.trim())
    throw new Error("RESEND_FROM_EMAIL is required when email delivery is enabled");
  if (
    !email &&
    values.RESEND_FROM_EMAIL?.trim() &&
    values.RESEND_FROM_EMAIL !== "RelayRTC <noreply@example.com>"
  )
    throw new Error("RESEND_API_KEY is required when a sender is configured");
  if (!local && origin.protocol !== "https:")
    throw new Error("Public hosting requires an HTTPS console origin");
  if (!email && values.SKIP_EMAIL_VERIFICATION && values.SKIP_EMAIL_VERIFICATION !== "true")
    throw new Error(
      "Local startup without email requires SKIP_EMAIL_VERIFICATION=true or an empty automatic setting",
    );
}

async function knownSettings() {
  const files = [
    ".env.example",
    "infrastructure/configuration/streaming.env.example",
    "infrastructure/configuration/advanced.env.example",
  ];
  return new Set(
    Object.keys(
      parseEnv(
        (await Promise.all(files.map((file) => readFile(join(assetDirectory, file), "utf8")))).join(
          "\n",
        ),
      ),
    ),
  );
}

async function readMetadata() {
  const text = await readOptional(metadataPath);
  if (!text) return undefined;
  const metadata = JSON.parse(text);
  if (
    metadata.schema !== 1 ||
    !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(metadata.project) ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
  ) {
    throw new Error(
      "Installation metadata is invalid; restore the saved configuration before continuing",
    );
  }
  return metadata;
}

async function configure(command, metadata) {
  if (metadata && metadata.version !== version)
    throw new Error(`Use setup:${metadata.version} to configure this installed release`);
  const existing = await readOptional(environmentPath);
  if (command === "import-env" && existing)
    throw new Error("Configuration already exists. Use configure to change individual settings.");
  const input = await readInput();
  const values = parseEnv(input);
  if (command === "import-env") {
    const required = [
      "RELAYRTC_VERSION",
      "POSTGRES_PASSWORD",
      "BETTER_AUTH_SECRET",
      "PARTICIPANT_TOKEN_SIGNING_SECRET",
      "RELAYRTC_INTERNAL_SECRET",
      "TURN_SHARED_SECRET",
      "GRAFANA_ADMIN_PASSWORD",
    ];
    if (values.RELAYRTC_STREAMING_ENABLED === "true")
      required.push(
        "STREAMING_SIGNING_SECRET",
        "STREAMING_WORKER_KEY",
        "STREAMING_GATEWAY_KEY",
        "STREAMING_DESTINATION_ENCRYPTION_KEY",
        "STREAMING_S3_ACCESS_KEY",
        "STREAMING_S3_SECRET_KEY",
        "STREAMING_STORAGE_ROOT_USER",
        "STREAMING_STORAGE_ROOT_PASSWORD",
      );
    if (required.some((name) => !values[name]?.trim() || values[name].startsWith("replace-with-")))
      throw new Error(
        "Import requires the complete original configuration, including existing credentials and release version",
      );
    if (!/^\d+\.\d+\.\d+$/.test(values.RELAYRTC_VERSION))
      throw new Error("Import requires the original RELAYRTC_VERSION");
  }
  const known = await knownSettings();
  if (
    command === "configure" &&
    Object.keys(values).some((name) => !known.has(name) || name === "RELAYRTC_VERSION")
  ) {
    throw new Error(
      "Configure accepts known service settings; use the matching setup image and upgrade command to change versions",
    );
  }
  if (command === "configure" && !existing)
    throw new Error(
      "Install RelayRTC before configuring it, or use import-env for an existing deployment",
    );
  if (metadata) {
    const current = parseEnv(existing);
    const fixed = [
      "POSTGRES_PASSWORD",
      "POSTGRES_USER",
      "POSTGRES_DB",
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
    if (fixed.some((name) => Object.hasOwn(values, name) && values[name] !== current[name]))
      throw new Error(
        "Infrastructure credentials require a coordinated rotation procedure; configure does not rotate them",
      );
  }
  const next = updateEnvironment(command === "import-env" ? "" : existing, values);
  if (values.STREAMING_CERTS_DIRECTORY && values.STREAMING_CERTS_DIRECTORY !== "./.streaming/certs")
    throw new Error(
      "Installer certificates belong in the configuration volume's runtime/streaming/certs directory",
    );
  if (metadata) validateSettings(parseEnv(next));
  await atomicWrite(environmentPath, next);
  if (command === "import-env")
    await atomicWrite(
      join(stateDirectory, "imported.json"),
      JSON.stringify({ importedAt: new Date().toISOString() }),
    );
  output(
    "Settings saved. No services were changed. Run the installer to apply settings, or upgrade when importing an older release.",
  );
}

async function install({ command, metadata, project, volume, attempt }) {
  const existingEnvironment = await readOptional(environmentPath);
  const imported = await readOptional(join(stateDirectory, "imported.json"));
  const previousVersion =
    metadata?.version ??
    (imported && existingEnvironment ? parseEnv(existingEnvironment).RELAYRTC_VERSION : undefined);
  if (previousVersion && previousVersion !== version && command !== "upgrade") {
    throw new Error(
      `This installation uses ${previousVersion}. Back up and drain it, then use the explicit upgrade command with setup:${version}.`,
    );
  }
  if (!metadata) {
    const containers = await docker(
      ["container", "ls", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
      { capture: true, signal },
    );
    const volumes = await docker(
      ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`],
      { capture: true, signal },
    );
    if ((containers.trim() || volumes.trim()) && !imported)
      throw new Error(
        `Docker project ${project} already exists. Import its original .env before adopting it, or use a different RELAYRTC_SETUP_PROJECT and distinct ports.`,
      );
    if (containers.trim() && command !== "upgrade")
      throw new Error(
        "Use upgrade after importing an existing project's original settings and draining its workloads",
      );
  }
  if (!existingEnvironment) {
    const template = await readFile(join(assetDirectory, ".env.example"), "utf8");
    const allowed = await knownSettings();
    const initial = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => allowed.has(name) && name !== "RELAYRTC_VERSION",
      ),
    );
    await atomicWrite(
      environmentPath,
      updateEnvironment(template, { ...initial, RELAYRTC_VERSION: version }),
    );
  }
  const backup = join(stateDirectory, "backups", `${Date.now()}-${metadata?.version ?? "initial"}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  if (existingEnvironment) await atomicWrite(join(backup, ".env"), existingEnvironment);
  const oldManifest = await readOptional(manifestPath);
  if (oldManifest) await atomicWrite(join(backup, "compose.json"), oldManifest);
  if (metadata)
    await atomicWrite(join(backup, "installation.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await atomicWrite(
    environmentPath,
    updateEnvironment(await readFile(environmentPath, "utf8"), { RELAYRTC_VERSION: version }),
  );
  const prepared = configureEnvironmentText(
    await readFile(join(assetDirectory, ".env.example"), "utf8"),
    await readFile(environmentPath, "utf8"),
    await readFile(
      join(assetDirectory, "infrastructure/configuration/streaming.env.example"),
      "utf8",
    ),
  );
  await atomicWrite(environmentPath, prepared.text);
  const values = parseEnv(await readFile(environmentPath, "utf8"));
  validateSettings(values);
  if (values.STREAMING_CERTS_DIRECTORY && values.STREAMING_CERTS_DIRECTORY !== "./.streaming/certs")
    throw new Error(
      "Installer certificates belong in runtime/streaming/certs inside the configuration volume",
    );
  await prepareStreaming(stateDirectory, values);
  await prepareRuntimeFiles();
  const manifest = await createManifest({ volume, version, project, signal });
  if (oldManifest && command === "upgrade") {
    const old = JSON.parse(oldManifest);
    if (old.services.postgres.image !== manifest.services.postgres.image)
      throw new Error(
        "The PostgreSQL image changed. Follow the database upgrade procedure before changing the stack.",
      );
  }
  if (command === "upgrade") {
    for (const [service, target, logicalVolume] of [
      ["postgres", "/var/lib/postgresql/data", "postgres-data"],
      ["streaming-storage", "/data", "streaming-data"],
      ["grafana", "/var/lib/grafana", "grafana-data"],
      ["prometheus", "/prometheus", "prometheus-data"],
    ]) {
      const ids = (
        await docker(
          [
            "container",
            "ls",
            "-aq",
            "--filter",
            `label=com.docker.compose.project=${project}`,
            "--filter",
            `label=com.docker.compose.service=${service}`,
          ],
          { capture: true, signal },
        )
      ).trim();
      if (!ids) continue;
      const containers = JSON.parse(
        await docker(["container", "inspect", ...ids.split(/\s+/)], { capture: true, signal }),
      );
      if (
        containers.some(
          (container) =>
            container.Mounts?.find((mount) => mount.Destination === target)?.Name !==
            manifest.volumes[logicalVolume]?.name,
        )
      )
        throw new Error(
          `The existing ${service} uses a different data mount; migrate its volumes explicitly before adoption`,
        );
      if (
        service === "postgres" &&
        containers.some((container) => container.Config.Image !== manifest.services.postgres.image)
      )
        throw new Error(
          "The PostgreSQL image differs from this release; follow the database upgrade procedure first",
        );
    }
  }
  const candidatePath = join(stateDirectory, "compose.pending.json");
  await atomicWrite(candidatePath, encodeManifest(manifest));
  await compose(candidatePath, project, ["config", "--quiet"], { signal, capture: true });
  output(`RelayRTC ${version}: downloading the complete rooms and streaming stack`);
  await compose(candidatePath, project, ["pull"], { signal });
  attempt.applying = true;
  if (command === "upgrade") {
    output(
      "Stopping application services before database migration; database and storage remain available",
    );
    await compose(
      oldManifest ? join(backup, "compose.json") : candidatePath,
      project,
      ["stop", ...appServices],
      { signal },
    );
  }
  await atomicWrite(manifestPath, encodeManifest(manifest));
  await atomicWrite(
    metadataPath,
    `${JSON.stringify(
      {
        schema: 1,
        project,
        version,
        volume,
        installedAt: metadata?.installedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "starting",
      },
      null,
      2,
    )}\n`,
  );
  output("Starting database, storage, migrations, calls, streaming and monitoring");
  await compose(
    manifestPath,
    project,
    ["up", "--detach", "--no-build", "--wait", "--wait-timeout", "600"],
    { signal },
  );
  await atomicWrite(
    metadataPath,
    `${JSON.stringify(
      {
        schema: 1,
        project,
        version,
        volume,
        installedAt: metadata?.installedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "ready",
      },
      null,
      2,
    )}\n`,
  );
  output(
    `\nRelayRTC is ready\n\nConsole: ${values.BETTER_AUTH_URL}\nAPI: ${new URL("/v1", values.STREAMING_PUBLIC_ORIGIN).href}\nSignaling: ${values.STREAMING_GUEST_SIGNALING_URL}\nGrafana: http://localhost:${values.GRAFANA_PORT || "3000"}\n\nRooms and streaming are included. Create your account in the console.\nConfiguration volume: ${volume}\nSetup can exit; your services keep running.`,
  );
}

async function main() {
  const [command = "install", ...extra] = process.argv.slice(2);
  if (!commands.has(command) || extra.length)
    throw new Error("Use a supported setup command without extra arguments; run help for the list");
  if (command === "help") {
    help();
    return;
  }
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("The setup image has no valid bundled release version");
  const server = JSON.parse(
    await docker(["version", "--format", "{{json .Server}}"], { capture: true, signal }),
  );
  const [apiMajor, apiMinor] = String(server.ApiVersion).split(".").map(Number);
  if (
    server.Os !== "linux" ||
    !Number.isInteger(apiMajor) ||
    !Number.isInteger(apiMinor) ||
    apiMajor < 1 ||
    (apiMajor === 1 && apiMinor < 45)
  )
    throw new Error(
      "RelayRTC setup requires a Linux Docker engine with API 1.45 or newer. Use Linux containers in Docker Desktop.",
    );
  const lock = await lockState(signal);
  try {
    const metadata = await readMetadata();
    if (metadata && metadata.volume !== lock.volume)
      throw new Error(
        "Configuration was copied from a different volume. Use a coordinated restore procedure rather than attaching mismatched state.",
      );
    const project = metadata?.project ?? process.env.RELAYRTC_SETUP_PROJECT ?? "relayrtc";
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(project))
      throw new Error("RELAYRTC_SETUP_PROJECT must be a short lowercase Docker project name");
    if (command === "import-env" || command === "configure") {
      await configure(command, metadata);
      return;
    }
    if (command === "export-env") {
      process.stdout.write(await readFile(environmentPath, "utf8"));
      return;
    }
    if (command === "credentials") {
      const values = parseEnv(await readFile(environmentPath, "utf8"));
      output(
        `Grafana username: ${values.GRAFANA_ADMIN_USER || "admin"}\nGrafana password: ${values.GRAFANA_ADMIN_PASSWORD}`,
      );
      return;
    }
    if (command === "install" || command === "upgrade") {
      const original = await readOptional(environmentPath);
      const attempt = { applying: false };
      try {
        await install({ command, metadata, project, volume: lock.volume, attempt });
      } catch (error) {
        if (original && !attempt.applying) await atomicWrite(environmentPath, original);
        throw error;
      }
      return;
    }
    if (!metadata)
      throw new Error("No installer-managed deployment exists in this configuration volume");
    await access(manifestPath);
    if (command === "start") {
      if (metadata.status !== "ready")
        throw new Error(
          "Setup did not complete. Rerun install with the matching setup image first.",
        );
      await compose(
        manifestPath,
        project,
        ["up", "--detach", "--no-build", "--wait", "--wait-timeout", "600"],
        { signal },
      );
    } else if (command === "stop")
      await compose(manifestPath, project, ["stop", ...appServices], { signal });
    else if (command === "status") await compose(manifestPath, project, ["ps", "-a"], { signal });
    else if (command === "logs")
      await compose(manifestPath, project, ["logs", "--tail", "100"], { signal });
  } finally {
    await lock.release();
  }
}

for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
main().catch((error) => {
  process.stderr.write(`RelayRTC setup stopped: ${error.message}\n`);
  process.exitCode = signal.aborted ? 130 : 1;
});
