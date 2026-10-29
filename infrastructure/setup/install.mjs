import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { docker } from "./docker.mjs";
import { lockState, version } from "./state.mjs";
import { generateInstallation, wizardState } from "./wizard-config.mjs";

const token = randomBytes(32).toString("hex");
const port = 9095;
const controller = new AbortController();
const signal = controller.signal;
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/wizard.css", ["wizard.css", "text/css; charset=utf-8"]],
  ["/console.css", ["console.css", "text/css; charset=utf-8"]],
  ["/relayrtc-logo.svg", ["relayrtc-logo.svg", "image/svg+xml"]],
  ["/fonts/inter-latin.woff2", ["fonts/inter-latin.woff2", "font/woff2"]],
  ["/fonts/relay-display-regular.woff2", ["fonts/relay-display-regular.woff2", "font/woff2"]],
  ["/fonts/relay-display-medium.woff2", ["fonts/relay-display-medium.woff2", "font/woff2"]],
  ["/fonts/relay-display-semibold.woff2", ["fonts/relay-display-semibold.woff2", "font/woff2"]],
]);
let busy = false;
let completed = false;
let lastAccess = Date.now();
let attempts = 0;
let attemptWindow = Date.now();

function equal(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

function authenticated(request) {
  return (
    request.headers.cookie
      ?.split(";")
      .some(
        (part) =>
          part.trim().startsWith("relayrtc_setup=") &&
          equal(part.trim().slice("relayrtc_setup=".length)),
      ) === true
  );
}

async function body(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("Send JSON settings");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new Error("Settings are too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function start() {
  const serverInfo = JSON.parse(
    await docker(["version", "--format", "{{json .Server}}"], { capture: true, signal }),
  );
  if (serverInfo.Os !== "linux") throw new Error("Use Docker's Linux container engine");
  const lock = await lockState(signal, { allowBind: true });
  if (lock.kind !== "bind") {
    await lock.release();
    throw new Error(
      "Mount your current host folder at /setup/state so the wizard can create ./relayrtc",
    );
  }
  let timeout;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 15000, keepAliveTimeout: 5000 },
    async (request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (!["localhost:9095", "127.0.0.1:9095", "[::1]:9095"].includes(request.headers.host)) {
        json(response, 403, {
          message:
            "Open the local setup address printed in the terminal. For a remote server, use SSH port forwarding.",
        });
        return;
      }
      let pathname;
      try {
        pathname = new URL(request.url, "http://localhost:9095").pathname;
      } catch {
        json(response, 400, { message: "Invalid setup address" });
        return;
      }
      if (request.method === "GET" && assets.has(pathname)) {
        const [file, type] = assets.get(pathname);
        try {
          const content = await readFile(join("/opt/relayrtc/ui", file));
          response.writeHead(200, { "content-type": type });
          response.end(content);
        } catch {
          json(response, 500, {
            message:
              "The setup image is missing its user interface. Rebuild the matching installer image.",
          });
        }
        return;
      }
      if (
        request.method === "POST" &&
        request.headers.origin !== `http://${request.headers.host}`
      ) {
        json(response, 403, { message: "Setup changes require the local browser origin" });
        return;
      }
      try {
        if (request.method === "POST" && pathname === "/api/session") {
          if (Date.now() - attemptWindow > 60000) {
            attempts = 0;
            attemptWindow = Date.now();
          }
          attempts += 1;
          if (attempts > 30) {
            json(response, 429, { message: "Wait a minute before opening setup again" });
            return;
          }
          if (!equal((await body(request)).token)) {
            json(response, 401, {
              message: "Open the complete setup link printed in your terminal",
            });
            return;
          }
          response.setHeader(
            "set-cookie",
            `relayrtc_setup=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
          );
          lastAccess = Date.now();
          json(response, 200, { authenticated: true });
          return;
        }
        if (!authenticated(request)) {
          json(response, 401, { message: "Open the complete setup link printed in your terminal" });
          return;
        }
        lastAccess = Date.now();
        if (request.method === "GET" && pathname === "/api/state") {
          json(response, 200, await wizardState());
          return;
        }
        if (request.method === "POST" && pathname === "/api/generate") {
          if (busy) {
            json(response, 409, { message: "Configuration is already being saved" });
            return;
          }
          busy = true;
          try {
            const result = await generateInstallation(await body(request), signal);
            completed = true;
            json(response, 200, result);
            process.stdout.write(
              "\nConfiguration saved. No application containers were started.\nIn a second terminal:\n  cd relayrtc\n  docker compose up -d --remove-orphans\n\nFinish setup in your browser or press Ctrl+C to close the installer.\n",
            );
          } finally {
            busy = false;
          }
          return;
        }
        if (request.method === "POST" && pathname === "/api/finish") {
          if (!completed || busy) {
            json(response, 409, { message: "Save configuration before finishing setup" });
            return;
          }
          response.setHeader(
            "set-cookie",
            "relayrtc_setup=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          json(response, 200, { finished: true });
          controller.abort();
          return;
        }
        json(response, 404, { message: "Setup endpoint not found" });
      } catch (error) {
        json(response, 400, {
          message:
            error instanceof SyntaxError
              ? "Settings could not be read. Check your entries."
              : error.message,
        });
      }
    },
  );
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
    process.stdout.write(
      `\nRelayRTC ${version} setup\nOpen this private link in your browser:\n\nhttp://localhost:${port}/#token=${token}\n\nPostgreSQL, rooms, streaming, mediasoup and coturn are included.\nConfiguration will be written to your mounted relayrtc folder.\n`,
    );
    timeout = setInterval(() => {
      if (!busy && Date.now() - lastAccess > 30 * 60 * 1000) controller.abort();
    }, 30000);
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
  } finally {
    clearInterval(timeout);
    if (busy) process.stdout.write("Stopping setup and preserving saved configuration\n");
    await new Promise((resolve) => server.close(resolve));
    await lock.release();
  }
}

for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
start().catch((error) => {
  process.stderr.write(`RelayRTC setup stopped: ${error.message}\n`);
  process.exitCode = 1;
});
