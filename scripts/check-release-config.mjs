import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { configureEnvironmentText } from "./configure-env.mjs";
import { releaseComposeFiles, sourceComposeFiles } from "./docker-compose.mjs";

// Configuration rendering needs the Docker CLI, not a running Docker engine.
// Never load the operator's .env or print resolved secrets.
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "relayrtc-release-config-"));
try {
  const template = readFileSync(join(root, ".env.example"), "utf8");
  const streaming = readFileSync(
    join(root, "infrastructure/configuration/streaming.env.example"),
    "utf8",
  );
  const advanced = readFileSync(
    join(root, "infrastructure/configuration/advanced.env.example"),
    "utf8",
  );
  const fixture = configureEnvironmentText(template, undefined, streaming).text;
  const fixturePath = join(directory, "fixture.env");
  writeFileSync(
    fixturePath,
    fixture +
      [
        "",
        "GITHUB_CLIENT_ID=config-check",
        "GITHUB_CLIENT_SECRET=config-check",
        "GOOGLE_CLIENT_ID=config-check",
        "GOOGLE_CLIENT_SECRET=config-check",
        "RESEND_API_KEY=config-check",
        "",
      ].join("\n"),
    { mode: 0o600 },
  );
  const env = { ...process.env };
  for (const name of Object.keys(parseEnv(template + "\n" + streaming + "\n" + advanced)))
    delete env[name];
  for (const name of [
    "COMPOSE_FILE",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PROFILES",
    "COMPOSE_ENV_FILES",
  ])
    delete env[name];
  const render = (files) => {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        fixturePath,
        "--project-directory",
        root,
        ...files.flatMap((file) => ["-f", join(root, file)]),
        "config",
        "--format",
        "json",
      ],
      { env, encoding: "utf8", windowsHide: true },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        "Docker Compose configuration failed. Check that the CLI is installed and the selected files parse.",
      );
    return JSON.parse(result.stdout);
  };
  const source = render(sourceComposeFiles);
  const full = render(releaseComposeFiles);
  assert.equal(Object.keys(source.services).length, 16);
  assert.equal(Object.keys(full.services).length, 16);
  assert.equal(full.services.api.environment.RELAYRTC_STREAMING_ENABLED, "true");
  assert.deepEqual(Object.keys(source.services).sort(), Object.keys(full.services).sort());
  const version = parseEnv(template).RELAYRTC_VERSION;
  const imageNames = new Set();
  for (const [name, service] of Object.entries(full.services)) {
    assert.ok(service.image, `${name} has no release image`);
    if (service.image.startsWith("ghcr.io/relayrtc/")) {
      assert.ok(service.image.endsWith(`:${version}`), `${name} has a mismatched release tag`);
      imageNames.add(service.image.split("/").at(-1).split(":")[0]);
    }
  }
  assert.equal(imageNames.size, 11);
  const workflow = readFileSync(
    join(root, ".github/workflows/publish-images.yml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const matrix = workflow.slice(workflow.indexOf("matrix:"), workflow.indexOf("    steps:"));
  for (const name of imageNames)
    assert.ok(
      matrix.includes(`- name: ${name}\n`),
      `Image ${name} is absent from the publication matrix`,
    );
  for (const [role, command] of [
    ["streaming-outputs", "output-server.js"],
    ["streaming-sources", "restream-server.js"],
    ["streaming-recordings", "recording-server.js"],
  ]) {
    assert.equal(full.services[role].command.at(-1), `services/streaming/dist/${command}`);
  }
  assert.equal(full.services["streaming-worker"].image, full.services["streaming-outputs"].image);
  console.log(
    `Release configuration passed: 16 services in both standard configurations, streaming enabled, 11 image families at ${version}. No containers started.`,
  );
} finally {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("relayrtc-release-config-"));
  rmSync(target, { recursive: true });
}
