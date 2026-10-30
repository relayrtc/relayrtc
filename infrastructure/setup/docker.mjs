import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseEnv, stripVTControlCharacters } from "node:util";

async function diagnostic(text, args, environment) {
  const values = { ...environment };
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "--env-file") continue;
    try {
      Object.assign(values, parseEnv(await readFile(args[index + 1], "utf8")));
    } catch {
      return "Docker error details could not be safely read. Check the environment file is readable.";
    }
  }
  let result = stripVTControlCharacters(text);
  const secrets = Object.entries(values)
    .filter(
      ([name, value]) => /secret|password|token|key|credential|database_url/i.test(name) && value,
    )
    .flatMap(([, value]) => [value, encodeURIComponent(value)])
    .sort((left, right) => right.length - left.length);
  for (const value of secrets) result = result.replaceAll(value, "[redacted]");
  result = result
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(
      /((?:secret|password|token|api[_-]?key|credential)[\w.-]*\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}]+)/gi,
      "$1[redacted]",
    )
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join("");
  return result.trim().slice(0, 3000);
}

export function docker(
  args,
  { capture = false, signal, environment = process.env, operation = "Docker operation" } = {},
) {
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
    const errors = [];
    let errorSize = 0;
    if (capture) {
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          exceeded = true;
          child.kill();
        } else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        if (errorSize + chunk.length <= 64 * 1024) errors.push(chunk);
        errorSize += chunk.length;
      });
    }
    child.once("error", () =>
      reject(new Error("Docker could not be started or setup was interrupted")),
    );
    child.once("close", async (code) => {
      if (code !== 0 || exceeded) {
        const detail =
          errorSize > 64 * 1024
            ? "Docker error output exceeded the diagnostic limit."
            : await diagnostic(Buffer.concat(errors).toString("utf8"), args, environment).catch(
                () => "Docker error details could not be safely displayed.",
              );
        reject(
          new Error(
            `${operation} failed (${exceeded ? "output limit exceeded" : code === null ? "interrupted" : `exit code ${code}`}).${detail ? ` ${detail}` : " Check that Docker Desktop or Docker Engine is running."}`,
          ),
        );
      } else resolve(capture ? Buffer.concat(chunks).toString("utf8") : "");
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
