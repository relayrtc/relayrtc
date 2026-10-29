import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { inspectContainer } from "./docker.mjs";

export const stateDirectory = "/setup/state";
export const assetDirectory = "/opt/relayrtc/assets";
export const { version } = JSON.parse(
  readFileSync(new URL("./release.json", import.meta.url), "utf8"),
);

export async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function atomicWrite(path, value, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export async function lockState(signal, { allowBind = false } = {}) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const identity = process.env.HOSTNAME;
  if (!identity || !/^[a-f0-9]{12,64}$/.test(identity))
    throw new Error("Use the default Docker container hostname for setup");
  const self = await inspectContainer(identity, { signal });
  const mount = self.Mounts?.find((item) => item.Destination === stateDirectory);
  if (
    !mount?.RW ||
    !((mount.Type === "volume" && mount.Name) || (allowBind && mount.Type === "bind"))
  ) {
    throw new Error(
      allowBind
        ? "Mount your installation parent folder at /setup/state"
        : "Mount a writable named volume at /setup/state, for example -v relayrtc-config:/setup/state",
    );
  }
  if (mount.Type === "volume") await chmod(stateDirectory, 0o700);
  const directory = join(stateDirectory, ".setup-lock");
  const ownerPath = join(directory, "owner");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const recovery = join(stateDirectory, ".setup-recovery");
    try {
      await mkdir(recovery, { mode: 0o700 });
    } catch (recoveryError) {
      throw new Error(
        "Setup lock recovery is busy; inspect /setup/state/.setup-recovery if the previous installer was interrupted",
        { cause: recoveryError },
      );
    }
    try {
      const owner = (await readOptional(ownerPath))?.trim();
      if (!owner || !/^[a-f0-9]{64}$/.test(owner))
        throw new Error(
          "Setup lock has no valid owner. Inspect /setup/state/.setup-lock before removing it.",
          { cause: error },
        );
      const running = await inspectContainer(owner, { signal })
        .then((item) => item.State.Running)
        .catch(async () => {
          const { docker } = await import("./docker.mjs");
          const ids = await docker(
            ["container", "ls", "-aq", "--no-trunc", "--filter", `id=${owner}`],
            { capture: true, signal },
          );
          return ids.trim() !== "";
        });
      if (running)
        throw new Error("Another setup process owns this installation; wait for it to finish", {
          cause: error,
        });
      await rm(directory, { recursive: true });
      await mkdir(directory, { mode: 0o700 });
    } finally {
      await rm(recovery, { recursive: true });
    }
  }
  await writeFile(ownerPath, self.Id, { mode: 0o600 });
  return {
    volume: mount.Name,
    kind: mount.Type,
    release: () => rm(directory, { recursive: true }),
  };
}

export function updateEnvironment(text, values) {
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== "string" || /[\r\n'\0]/.test(value)) {
      throw new Error(
        "A setting has an invalid name or contains an unsupported quote/control character",
      );
    }
    const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, "gm");
    const line = `${name}='${value}'`;
    text = pattern.test(text) ? text.replace(pattern, () => line) : `${text.trimEnd()}\n${line}\n`;
  }
  return `${text.trimEnd()}\n`;
}

export async function readInput() {
  if (process.stdin.isTTY)
    throw new Error("Pipe dotenv settings into this command using standard input");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 262144) throw new Error("Settings must fit within 256 KiB");
  }
  if (!input.trim()) throw new Error("No settings were supplied on standard input");
  parseEnv(input);
  return input;
}
