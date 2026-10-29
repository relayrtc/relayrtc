import { spawn } from "node:child_process";

export function docker(args, { capture = false, signal, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { ...environment, DOCKER_HOST: "unix:///var/run/docker.sock" },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    const chunks = [];
    let size = 0;
    let exceeded = false;
    if (capture) {
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          exceeded = true;
          child.kill();
        } else chunks.push(chunk);
      });
      child.stderr.resume();
    }
    child.once("error", () =>
      reject(new Error("Docker could not be started or setup was interrupted")),
    );
    child.once("close", (code) => {
      if (code !== 0 || exceeded)
        reject(
          new Error(
            "Docker could not complete the requested operation. Existing configuration and data were retained.",
          ),
        );
      else resolve(capture ? Buffer.concat(chunks).toString("utf8") : "");
    });
  });
}

export async function inspectContainer(name, options) {
  const result = JSON.parse(
    await docker(["container", "inspect", name], { ...options, capture: true }),
  );
  if (!Array.isArray(result) || result.length !== 1)
    throw new Error("Cannot identify the setup container");
  return result[0];
}
