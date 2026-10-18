import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";

const environmentPath = new URL("../.env", import.meta.url);
const examplePath = new URL("../.env.example", import.meta.url);

if (!existsSync(environmentPath)) {
  const postgresPassword = randomBytes(24).toString("hex");
  const values = readFileSync(examplePath, "utf8")
    .replace("replace-with-a-random-password", postgresPassword)
    .replace(
      "postgresql://relaykit:replace-with-a-random-password@localhost:5433/relaykit",
      `postgresql://relaykit:${postgresPassword}@localhost:5433/relaykit`,
    )
    .replace(
      "RELAYRTC_INTERNAL_SECRET=replace-with-at-least-32-random-characters",
      `RELAYRTC_INTERNAL_SECRET=${randomBytes(32).toString("hex")}`,
    )
    .replace(
      "PARTICIPANT_TOKEN_SIGNING_SECRET=replace-with-at-least-32-random-characters",
      `PARTICIPANT_TOKEN_SIGNING_SECRET=${randomBytes(32).toString("hex")}`,
    )
    .replace(
      "BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters",
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
    )
    .replace(
      "TURN_SHARED_SECRET=replace-with-at-least-32-random-characters",
      `TURN_SHARED_SECRET=${randomBytes(32).toString("hex")}`,
    )
    .replace("replace-with-a-random-password", randomBytes(24).toString("hex"));

  writeFileSync(environmentPath, values, { encoding: "utf8", mode: 0o600 });
  process.stdout.write("Created .env with generated local secrets.\n");
}

const existingEnvironment = readFileSync(environmentPath, "utf8");
if (!/^RELAYRTC_INTERNAL_SECRET=/m.test(existingEnvironment)) {
  writeFileSync(
    environmentPath,
    `${existingEnvironment.trimEnd()}\nRELAYRTC_INTERNAL_SECRET=${randomBytes(32).toString("hex")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write("Generated a separate internal control credential in .env.\n");
}

loadEnvFile(environmentPath);
const streamingRequested = process.argv.includes("--streaming");
let configuredEnvironment = readFileSync(environmentPath, "utf8");
const streamingEnabled = streamingRequested || process.env.RELAYRTC_STREAMING_ENABLED === "true";
if (streamingEnabled) {
  const setValue = (name, value) => {
    const line = new RegExp(`^${name}=.*$`, "m");
    configuredEnvironment = line.test(configuredEnvironment)
      ? configuredEnvironment.replace(line, `${name}=${value}`)
      : `${configuredEnvironment.trimEnd()}\n${name}=${value}\n`;
  };
  setValue("RELAYRTC_STREAMING_ENABLED", "true");
  for (const name of [
    "STREAMING_DESTINATION_ENCRYPTION_KEY",
    "STREAMING_SIGNING_SECRET",
    "STREAMING_WORKER_KEY",
    "STREAMING_GATEWAY_KEY",
    "STREAMING_S3_ACCESS_KEY",
    "STREAMING_S3_SECRET_KEY",
    "STREAMING_STORAGE_ROOT_USER",
    "STREAMING_STORAGE_ROOT_PASSWORD",
  ]) {
    if (!process.env[name]?.trim()) {
      const value = ["STREAMING_S3_ACCESS_KEY", "STREAMING_STORAGE_ROOT_USER"].includes(name)
        ? `relayrtc_${randomBytes(6).toString("hex")}`
        : randomBytes(32).toString(
            name === "STREAMING_DESTINATION_ENCRYPTION_KEY" ? "base64" : "base64url",
          );
      setValue(name, value);
      process.env[name] = value;
    }
  }
  if (!process.env.STREAMING_PUBLIC_ORIGIN?.trim())
    setValue("STREAMING_PUBLIC_ORIGIN", `http://localhost:${process.env.API_PORT || "8080"}`);
  writeFileSync(environmentPath, configuredEnvironment, { encoding: "utf8", mode: 0o600 });
  await import("./prepare-streaming.mjs");
  process.stdout.write(
    "Enabling the local streaming stack. Existing credentials were preserved.\n",
  );
}

const composeFiles = streamingEnabled
  ? ["-f", "docker-compose.yml", "-f", "docker-compose.streaming.yml"]
  : [];

const docker = spawn(
  "docker",
  [
    "compose",
    "--env-file",
    ".env",
    ...composeFiles,
    "up",
    "--detach",
    "--build",
    "--wait",
    "--wait-timeout",
    "180",
    "--remove-orphans",
  ],
  { cwd: new URL("..", import.meta.url), stdio: "inherit" },
);

docker.on("error", (error) => {
  process.stderr.write(`Unable to start Docker Compose: ${error.message}\n`);
  process.exitCode = 1;
});

docker.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
