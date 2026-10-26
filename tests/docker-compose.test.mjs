import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";

import {
  composeArguments,
  releaseComposeFiles,
  runDockerCompose,
  sourceComposeFiles,
} from "../scripts/docker-compose.mjs";
import { startDocker } from "../scripts/docker-up.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "relayrtc-startup-test-"));
  mkdirSync(join(directory, "infrastructure/configuration"), { recursive: true });
  writeFileSync(join(directory, ".env.example"), read("../.env.example"));
  writeFileSync(
    join(directory, "infrastructure/configuration/streaming.env.example"),
    read("../infrastructure/configuration/streaming.env.example"),
  );
  return directory;
}

function clean(directory) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("relayrtc-startup-test-"));
  rmSync(target, { recursive: true });
}

test("all standard commands select the complete stack in the same order", () => {
  assert.deepEqual(sourceComposeFiles, ["docker-compose.yml", "docker-compose.streaming.yml"]);
  const prefix = [
    "compose",
    "--env-file",
    ".env",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.streaming.yml",
  ];
  for (const command of ["up", "config", "down", "logs", "status"])
    assert.deepEqual(composeArguments(command).slice(0, prefix.length), prefix);
  assert.ok(composeArguments("up").includes("--build"));
  assert.ok(composeArguments("up").includes("--wait"));
  assert.ok(composeArguments("status").includes("-a"));
  assert.ok(!composeArguments("down").includes("--volumes"));
  assert.deepEqual(composeArguments("logs", ["streaming-worker"]).slice(-1), ["streaming-worker"]);
  assert.throws(() => composeArguments("unsupported"));
});

test("the release selects all services before applying both image overrides", () => {
  assert.deepEqual(releaseComposeFiles, [
    ...sourceComposeFiles,
    "docker-compose.release.yml",
    "docker-compose.streaming.release.yml",
  ]);
});

test("Docker commands preserve arguments, working directory, environment and exit status", async () => {
  const environment = { PATH: "fixture-path" };
  let invocations = 0;
  const result = await runDockerCompose("logs", ["streaming-worker"], {
    directory: "fixture-directory",
    environment,
    spawnProcess(program, args, options) {
      invocations++;
      assert.equal(program, "docker");
      assert.deepEqual(args, composeArguments("logs", ["streaming-worker"]));
      assert.equal(options.cwd, "fixture-directory");
      assert.equal(options.env, environment);
      assert.equal(options.stdio, "inherit");
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, undefined);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 7));
      return child;
    },
  });
  assert.equal(invocations, 1);
  assert.equal(result, 7);
});

test("a Docker launch error rejects instead of reporting a successful startup", async () => {
  const failure = new Error("Docker executable unavailable");
  await assert.rejects(
    runDockerCompose("status", [], {
      spawnProcess() {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("error", failure));
        return child;
      },
    }),
    failure,
  );
});

test("ordinary startup prepares streaming before Docker and preserves saved credentials", async () => {
  const directory = fixture();
  try {
    writeFileSync(
      join(directory, ".env"),
      [
        "RELAYRTC_STREAMING_ENABLED=false",
        "POSTGRES_PASSWORD=existing-database-password",
        `STREAMING_WORKER_KEY=${"w".repeat(43)}`,
        `STREAMING_GATEWAY_KEY=${"g".repeat(43)}`,
        "STREAMING_PUBLIC_ORIGIN=https://video.example.com",
      ].join("\n"),
    );
    let launches = 0;
    const launch = (command, args, options) => {
      launches++;
      const values = parseEnv(readFileSync(join(directory, ".env"), "utf8"));
      assert.equal(command, "up");
      assert.deepEqual(args, []);
      assert.equal(options.directory, directory);
      assert.equal(values.RELAYRTC_STREAMING_ENABLED, "true");
      assert.equal(values.POSTGRES_PASSWORD, "existing-database-password");
      assert.equal(values.STREAMING_PUBLIC_ORIGIN, "https://video.example.com");
      assert.equal(
        readFileSync(join(directory, ".streaming/worker-key"), "utf8"),
        values.STREAMING_WORKER_KEY,
      );
      assert.equal(
        readFileSync(join(directory, ".streaming/gateway-key"), "utf8"),
        values.STREAMING_GATEWAY_KEY,
      );
      assert.ok(existsSync(join(directory, ".streaming/certs")));
      return 0;
    };
    assert.equal(await startDocker({ directory, environment: {}, launch }), 0);
    const saved = readFileSync(join(directory, ".env"), "utf8");
    assert.equal(await startDocker({ directory, environment: {}, launch }), 0);
    assert.equal(readFileSync(join(directory, ".env"), "utf8"), saved);
    assert.equal(launches, 2);
  } finally {
    clean(directory);
  }
});

test("monitoring keys honor parent environment overrides just as Compose does", async () => {
  const directory = fixture();
  try {
    const environment = {
      STREAMING_WORKER_KEY: "p".repeat(43),
      STREAMING_GATEWAY_KEY: "q".repeat(43),
    };
    await startDocker({
      directory,
      environment,
      launch(_command, _args, options) {
        assert.equal(options.environment, environment);
        assert.equal(
          readFileSync(join(directory, ".streaming/worker-key"), "utf8"),
          environment.STREAMING_WORKER_KEY,
        );
        assert.equal(
          readFileSync(join(directory, ".streaming/gateway-key"), "utf8"),
          environment.STREAMING_GATEWAY_KEY,
        );
        return 0;
      },
    });
  } finally {
    clean(directory);
  }
});

test("invalid monitoring credentials prevent Docker startup without writing partial bind files", async () => {
  const directory = fixture();
  try {
    let launched = false;
    await assert.rejects(
      startDocker({
        directory,
        environment: { STREAMING_GATEWAY_KEY: "invalid" },
        launch() {
          launched = true;
          return 0;
        },
      }),
      /STREAMING_GATEWAY_KEY/,
    );
    assert.equal(launched, false);
    assert.equal(existsSync(join(directory, ".streaming")), false);
  } finally {
    clean(directory);
  }
});

test("package commands and compatibility aliases use the standard helpers", () => {
  const { scripts } = JSON.parse(read("../package.json"));
  assert.equal(scripts["docker:up"], "node scripts/docker-up.mjs");
  for (const command of ["config", "down", "logs", "status"])
    assert.equal(scripts[`docker:${command}`], `node scripts/docker-compose.mjs ${command}`);
  assert.equal(scripts["docker:up:streaming"], scripts["docker:up"]);
  assert.equal(scripts["env:configure:streaming"], scripts["env:configure"]);
});
