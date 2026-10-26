import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { prepareStreaming } from "./prepare-streaming.mjs";

const placeholder = (value) =>
  !value?.trim() ||
  ["replace-with-a-random-password", "replace-with-at-least-32-random-characters"].includes(value);

/** Prepare dotenv text without reading process environment or starting services. */
export function configureEnvironmentText(template, existing, streamingTemplate) {
  let text = (existing ?? template).replaceAll("\r\n", "\n");
  let values = parseEnv(text);
  const set = (name, value) => {
    // All generated/derived values are quoted to keep dotenv delimiters literal.
    if (/[\r\n']/u.test(value)) throw new Error(`Cannot safely encode generated setting ${name}`);
    const encoded = `'${value}'`;
    const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, "gm");
    text = pattern.test(text)
      ? text.replace(pattern, () => `${name}=${encoded}`)
      : `${text.trimEnd()}\n${name}=${encoded}\n`;
    values[name] = value;
  };
  const mergeMissing = (source) => {
    for (const [name, value] of Object.entries(parseEnv(source))) {
      if (!(name in values)) set(name, value);
    }
  };
  mergeMissing(template);
  for (const name of [
    "POSTGRES_PASSWORD",
    "BETTER_AUTH_SECRET",
    "PARTICIPANT_TOKEN_SIGNING_SECRET",
    "RELAYRTC_INTERNAL_SECRET",
    "TURN_SHARED_SECRET",
    "GRAFANA_ADMIN_PASSWORD",
    "WEBHOOK_SIGNING_ENCRYPTION_KEY",
  ]) {
    if (placeholder(values[name]))
      set(
        name,
        randomBytes(32).toString(name === "WEBHOOK_SIGNING_ENCRYPTION_KEY" ? "base64" : "hex"),
      );
  }
  // Host tooling only. Compose supplies its own database URL inside containers.
  if (
    placeholder(values.DATABASE_URL) ||
    values.DATABASE_URL?.includes("replace-with-a-random-password")
  ) {
    const component = (value) => encodeURIComponent(value).replaceAll("'", "%27");
    const user = component(values.POSTGRES_USER || "relaykit");
    const password = component(values.POSTGRES_PASSWORD);
    const database = component(values.POSTGRES_DB || "relaykit");
    set(
      "DATABASE_URL",
      `postgresql://${user}:${password}@localhost:${values.POSTGRES_PORT || "5433"}/${database}`,
    );
  }
  // The standard installation always includes streaming, including upgrades
  // from an older starter that explicitly disabled it. Other values are retained.
  mergeMissing(streamingTemplate);
  set("RELAYRTC_STREAMING_ENABLED", "true");
  for (const name of [
    "STREAMING_SIGNING_SECRET",
    "STREAMING_WORKER_KEY",
    "STREAMING_GATEWAY_KEY",
    "STREAMING_DESTINATION_ENCRYPTION_KEY",
    "STREAMING_S3_ACCESS_KEY",
    "STREAMING_S3_SECRET_KEY",
    "STREAMING_STORAGE_ROOT_USER",
    "STREAMING_STORAGE_ROOT_PASSWORD",
  ]) {
    if (placeholder(values[name])) {
      const identity = ["STREAMING_S3_ACCESS_KEY", "STREAMING_STORAGE_ROOT_USER"].includes(name);
      set(
        name,
        identity
          ? `relayrtc_${randomBytes(8).toString("hex")}`
          : randomBytes(32).toString(
              name === "STREAMING_DESTINATION_ENCRYPTION_KEY" ? "base64" : "base64url",
            ),
      );
    }
  }
  if (!values.STREAMING_PUBLIC_ORIGIN?.trim())
    set("STREAMING_PUBLIC_ORIGIN", `http://localhost:${values.API_PORT || "8080"}`);
  if (!values.STREAMING_GUEST_SIGNALING_URL?.trim())
    set(
      "STREAMING_GUEST_SIGNALING_URL",
      `ws://localhost:${values.SIGNALING_PORT || "8081"}/v1/connect`,
    );
  if (!values.STREAMING_ALLOWED_ORIGINS?.trim())
    set(
      "STREAMING_ALLOWED_ORIGINS",
      values.RELAYRTC_SIGNALING_ALLOWED_ORIGINS || values.BETTER_AUTH_URL,
    );
  return { text: text.trimEnd() + "\n", streaming: true };
}

export function configureEnvironment(directory) {
  const destination = resolve(directory, ".env");
  const existing = existsSync(destination) ? readFileSync(destination, "utf8") : undefined;
  const template = readFileSync(resolve(directory, ".env.example"), "utf8");
  const result = configureEnvironmentText(
    template,
    existing,
    readFileSync(resolve(directory, "infrastructure/configuration/streaming.env.example"), "utf8"),
  );
  if (result.text !== existing)
    writeFileSync(destination, result.text, { encoding: "utf8", mode: 0o600 });
  return { changed: result.text !== existing, streaming: result.streaming };
}

/** Prepare the complete installation without starting Docker or loading secrets globally. */
export async function prepareInstallation(directory, environment = process.env) {
  const result = configureEnvironment(directory);
  const values = parseEnv(readFileSync(resolve(directory, ".env"), "utf8"));
  // Compose gives the parent environment precedence over --env-file as well.
  await prepareStreaming(directory, { ...values, ...environment });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--streaming"))
    throw new Error("Usage: node scripts/configure-env.mjs");
  // --streaming remains accepted for older callers; it is no longer necessary.
  const result = await prepareInstallation(fileURLToPath(new URL("..", import.meta.url)));
  process.stdout.write(
    `${result.changed ? "Prepared" : "Preserved"} .env; prepared .streaming. No services were started.\nReview provider credentials and public addresses before startup.\n`,
  );
}
