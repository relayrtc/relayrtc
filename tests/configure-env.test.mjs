import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { configureEnvironment, configureEnvironmentText } from "../scripts/configure-env.mjs";

const template = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const streamingTemplate = readFileSync(
  new URL("../infrastructure/configuration/streaming.env.example", import.meta.url),
  "utf8",
);
const prepare = (existing) => configureEnvironmentText(template, existing, streamingTemplate);

test("standard installation prepares streaming and preserves the file on repeated setup", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayrtc-config-test-"));
  try {
    writeFileSync(join(directory, ".env.example"), template);
    mkdirSync(join(directory, "infrastructure/configuration"), { recursive: true });
    writeFileSync(
      join(directory, "infrastructure/configuration/streaming.env.example"),
      streamingTemplate,
    );
    assert.equal(configureEnvironment(directory).changed, true);
    const existing = readFileSync(join(directory, ".env"), "utf8");
    assert.equal(configureEnvironment(directory).changed, false);
    assert.equal(readFileSync(join(directory, ".env"), "utf8"), existing);
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("relayrtc-config-test-"));
    rmSync(target, { recursive: true });
  }
});

test("fresh setup generates distinct secrets and leaves provider credentials for the operator", () => {
  const prepared = prepare();
  const values = parseEnv(prepared.text);
  const keys = [
    "POSTGRES_PASSWORD",
    "BETTER_AUTH_SECRET",
    "PARTICIPANT_TOKEN_SIGNING_SECRET",
    "RELAYRTC_INTERNAL_SECRET",
    "TURN_SHARED_SECRET",
    "GRAFANA_ADMIN_PASSWORD",
  ];
  assert.equal(new Set(keys.map((key) => values[key])).size, keys.length);
  for (const key of keys) assert.match(values[key], /^[a-f0-9]{64}$/u);
  assert.equal(Buffer.from(values.WEBHOOK_SIGNING_ENCRYPTION_KEY, "base64").length, 32);
  assert.equal(values.RELAYRTC_VERSION, "0.1.4");
  assert.equal(values.SKIP_EMAIL_VERIFICATION, "");
  assert.equal(values.GITHUB_CLIENT_SECRET, "");
  assert.equal(values.GOOGLE_CLIENT_SECRET, "");
  assert.equal(values.RESEND_API_KEY, "");
  assert.equal(prepared.streaming, true);
  assert.equal(values.RELAYRTC_STREAMING_ENABLED, "true");
  assert.match(values.STREAMING_WORKER_KEY, /^[A-Za-z0-9_-]{43}$/u);
});

test("repeated setup preserves generated keys and is textually idempotent", () => {
  const first = prepare();
  assert.equal(prepare(first.text).text, first.text);
});

test("an older disabled streaming flag is enabled without rotating existing credentials", () => {
  const first = prepare();
  const legacy = first.text.replace(
    "RELAYRTC_STREAMING_ENABLED='true'",
    "RELAYRTC_STREAMING_ENABLED=false",
  );
  const updated = prepare(legacy);
  assert.equal(updated.streaming, true);
  assert.deepEqual(parseEnv(updated.text), parseEnv(first.text));
});

test("existing credentials, version, URLs, unknown settings and comments are preserved", () => {
  const existing = [
    "# Operator-owned configuration",
    "RELAYRTC_VERSION=0.1.1",
    "POSTGRES_PASSWORD='existing$secret#value'",
    "BETTER_AUTH_SECRET=existing-auth-secret-not-for-rotation",
    "DATABASE_URL='postgresql://existing.example/managed'",
    "STREAMING_PUBLIC_ORIGIN=https://media.example.com",
    "CUSTOM_SETTING=keep-me",
  ].join("\n");
  const prepared = prepare(existing);
  const values = parseEnv(prepared.text);
  assert.equal(values.RELAYRTC_VERSION, "0.1.1");
  assert.equal(values.POSTGRES_PASSWORD, "existing$secret#value");
  assert.equal(values.BETTER_AUTH_SECRET, "existing-auth-secret-not-for-rotation");
  assert.equal(values.DATABASE_URL, "postgresql://existing.example/managed");
  assert.equal(values.STREAMING_PUBLIC_ORIGIN, "https://media.example.com");
  assert.equal(values.CUSTOM_SETTING, "keep-me");
  assert.ok(prepared.text.includes("# Operator-owned configuration"));
});

test("known placeholders are replaced without replacing configured secrets", () => {
  const values = parseEnv(
    prepare(
      "POSTGRES_PASSWORD=replace-with-a-random-password\nTURN_SHARED_SECRET=replace-with-at-least-32-random-characters\nGRAFANA_ADMIN_PASSWORD=operator-password\n",
    ).text,
  );
  assert.match(values.POSTGRES_PASSWORD, /^[a-f0-9]{64}$/u);
  assert.match(values.TURN_SHARED_SECRET, /^[a-f0-9]{64}$/u);
  assert.equal(values.GRAFANA_ADMIN_PASSWORD, "operator-password");
});

test("host database URL encodes user credentials and uses the chosen port", () => {
  const values = parseEnv(
    prepare(
      "POSTGRES_USER=operator\nPOSTGRES_PASSWORD='p@ss:word$#'\nPOSTGRES_DB=custom\nPOSTGRES_PORT=5544\n",
    ).text,
  );
  const url = new URL(values.DATABASE_URL);
  assert.equal(decodeURIComponent(url.password), "p@ss:word$#");
  assert.equal(url.username, "operator");
  assert.equal(url.port, "5544");
  assert.equal(url.pathname, "/custom");
});

test("streaming generates independent correctly encoded credentials and derives local origins", () => {
  const prepared = prepare(
    "API_PORT=9080\nSIGNALING_PORT=9081\nRELAYRTC_SIGNALING_ALLOWED_ORIGINS=https://console.example.com,https://app.example.com\n",
  );
  const values = parseEnv(prepared.text);
  for (const key of ["STREAMING_SIGNING_SECRET", "STREAMING_WORKER_KEY", "STREAMING_GATEWAY_KEY"])
    assert.match(values[key], /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(values.STREAMING_DESTINATION_ENCRYPTION_KEY, "base64").length, 32);
  assert.notEqual(values.STREAMING_WORKER_KEY, values.STREAMING_GATEWAY_KEY);
  assert.notEqual(values.STREAMING_S3_SECRET_KEY, values.STREAMING_STORAGE_ROOT_PASSWORD);
  assert.equal(values.STREAMING_PUBLIC_ORIGIN, "http://localhost:9080");
  assert.equal(values.STREAMING_GUEST_SIGNALING_URL, "ws://localhost:9081/v1/connect");
  assert.equal(
    values.STREAMING_ALLOWED_ORIGINS,
    "https://console.example.com,https://app.example.com",
  );
  assert.equal(values.STREAMING_SOURCE_ALLOWED_HOSTS, "");
});

test("later base-port changes do not rewrite configured streaming origins", () => {
  const first = prepare();
  const changedPorts = first.text.replace("API_PORT=8080", "API_PORT=9080");
  const repeated = prepare(changedPorts);
  assert.equal(repeated.streaming, true);
  assert.equal(parseEnv(repeated.text).STREAMING_PUBLIC_ORIGIN, "http://localhost:8080");
});

test("every Compose input is represented by a starter or advanced template", () => {
  const advanced = readFileSync(
    new URL("../infrastructure/configuration/advanced.env.example", import.meta.url),
    "utf8",
  );
  const documented = {
    ...parseEnv(template),
    ...parseEnv(streamingTemplate),
    ...parseEnv(advanced),
  };
  for (const file of [
    "../docker-compose.yml",
    "../docker-compose.streaming.yml",
    "../docker-compose.release.yml",
    "../docker-compose.streaming.release.yml",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/gu))
      assert.ok(match[1] in documented, `${match[1]} is missing from configuration templates`);
  }
});
