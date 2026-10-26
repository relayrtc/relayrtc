import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const sourceComposeFiles = Object.freeze([
  "docker-compose.yml",
  "docker-compose.streaming.yml",
]);

export const releaseComposeFiles = Object.freeze([
  ...sourceComposeFiles,
  "docker-compose.release.yml",
  "docker-compose.streaming.release.yml",
]);

const commands = {
  config: ["config", "--quiet"],
  down: ["down", "--remove-orphans"],
  logs: ["logs", "--follow"],
  status: ["ps", "-a"],
  up: ["up", "--detach", "--build", "--wait", "--wait-timeout", "180", "--remove-orphans"],
};

export function composeArguments(command, args = []) {
  if (!Object.hasOwn(commands, command))
    throw new Error("Use a Docker command: config, down, logs, status or up");
  return [
    "compose",
    "--env-file",
    ".env",
    ...sourceComposeFiles.flatMap((file) => ["-f", file]),
    ...commands[command],
    ...args,
  ];
}

export function runDockerCompose(
  command,
  args = [],
  { directory = root, environment = process.env, spawnProcess = spawn } = {},
) {
  const dockerArgs = composeArguments(command, args);
  return new Promise((resolveExit, reject) => {
    const docker = spawnProcess("docker", dockerArgs, {
      cwd: directory,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    docker.once("error", reject);
    docker.once("exit", (code) => resolveExit(code ?? 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  // Startup always goes through preparation, including when invoked directly.
  if (command === "up") {
    const { prepareInstallation } = await import("./configure-env.mjs");
    await prepareInstallation(root);
  }
  process.exitCode = await runDockerCompose(command, args);
}
