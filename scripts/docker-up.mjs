import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareInstallation } from "./configure-env.mjs";
import { runDockerCompose } from "./docker-compose.mjs";

const directory = fileURLToPath(new URL("..", import.meta.url));

export async function startDocker({
  directory: installDirectory = directory,
  environment = process.env,
  launch = runDockerCompose,
  args = [],
} = {}) {
  const prepared = await prepareInstallation(installDirectory, environment);
  if (prepared.changed)
    process.stdout.write(
      "Prepared .env; existing credentials were preserved. Streaming is enabled.\n",
    );
  return launch("up", args, { directory: installDirectory, environment });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Older callers may still pass --streaming. All startup paths now include it.
  const args = process.argv.slice(2).filter((arg) => arg !== "--streaming");
  try {
    process.exitCode = await startDocker({ args });
  } catch (error) {
    process.stderr.write(`Unable to start Docker Compose: ${error.message}\n`);
    process.exitCode = 1;
  }
}
