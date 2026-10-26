import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { releaseComposeFiles } from "../scripts/docker-compose.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("installation guides select the matching release archive and required assets exist", () => {
  const version = parseEnv(read("../.env.example")).RELAYRTC_VERSION;
  for (const guide of ["../../docs/self-hosting.mdx"]) {
    const source = read(guide);
    assert.ok(
      source.includes(`https://github.com/relayrtc/relayrtc/archive/refs/tags/v${version}.zip`),
      `Archive version does not match the installation template: ${guide}`,
    );
  }
  for (const file of [
    "docker-compose.yml",
    "docker-compose.release.yml",
    "docker-compose.streaming.yml",
    "docker-compose.streaming.release.yml",
    ".env.example",
    "scripts/configure-env.mjs",
    "scripts/prepare-streaming.mjs",
    "infrastructure/configuration/streaming.env.example",
    "infrastructure/streaming/mediamtx.yml",
    "infrastructure/prometheus/streaming.yml",
    "infrastructure/prometheus/streaming.rules.yml",
  ]) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `Missing release asset ${file}`);
  }
});

test("the installation guide prepares and starts the complete streaming stack", () => {
  const source = read("../../docs/self-hosting.mdx");
  assert.ok(source.includes("prepared .streaming"));
  assert.ok(source.includes("streaming-storage-init"));
  assert.ok(source.includes("prepare-streaming.mjs"));
  assert.doesNotMatch(source, /configure-env\.mjs --streaming/u);
  assert.equal(parseEnv(read("../.env.example")).RELAYRTC_STREAMING_ENABLED, "true");
});

test("all documented release commands select the standard configuration", () => {
  for (const guide of [
    "../../docs/self-hosting.mdx",
    "../../docs/guides/self-hosting-operations.mdx",
    "../../docs/guides/streaming-self-hosting.mdx",
    "../../docs/guides/streaming-operations.mdx",
    "../infrastructure/docker/README.md",
  ]) {
    const source = read(guide);
    const commands = [...source.matchAll(/docker compose --env-file \.env ([^\n]+)/gu)];
    assert.ok(commands.length > 0, `Missing release command in ${guide}`);
    for (const [, command] of commands) {
      const files = [...command.matchAll(/-f ([\w.-]+\.yml)/gu)].map((match) => match[1]);
      assert.deepEqual(files, releaseComposeFiles, `Incomplete release command in ${guide}`);
    }
  }
});

test("documentation API addresses agree with the starter port", () => {
  const { API_PORT } = parseEnv(read("../.env.example"));
  const root = fileURLToPath(new URL("../../docs/", import.meta.url));
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.name === ".git"
        ? []
        : entry.isDirectory()
          ? walk(join(directory, entry.name))
          : entry.name.endsWith(".mdx")
            ? [join(directory, entry.name)]
            : [],
    );
  for (const file of walk(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/http:\/\/localhost:(\d+)\/v1\b/gu))
      assert.equal(match[1], API_PORT, `API address disagrees with .env.example in ${file}`);
  }
});

test("streaming release roles use published image names without replacing worker commands", () => {
  const release = read("../docker-compose.streaming.release.yml");
  const roles = [...release.matchAll(/^  ([a-z-]+):\n    image: ghcr\.io\/relayrtc\/([^\n]+)$/gmu)];
  assert.equal(roles.length, 6);
  const expected = {
    "streaming-worker": "streaming",
    "streaming-outputs": "streaming",
    "streaming-sources": "streaming",
    "streaming-recordings": "streaming",
    "streaming-storage": "streaming-storage",
    "streaming-storage-init": "streaming-storage-init",
  };
  for (const [, role, image] of roles) {
    assert.equal(image, `${expected[role]}:${"${RELAYRTC_VERSION:-0.1.2}"}`);
  }
  assert.doesNotMatch(release, /^\s+(command|environment|volumes|networks):/mu);
});
