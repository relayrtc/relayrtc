const form = document.querySelector("#setup");
const fields = document.querySelector("#fields");
const error = document.querySelector("#error");
const back = document.querySelector("#back");
const next = document.querySelector("#next");
const labels = ["Addresses", "Media", "Integrations", "Review"];
const values = {
  mode: "local",
  hostname: "",
  consoleOrigin: "http://localhost:3002",
  apiOrigin: "http://localhost:8080",
  signalingOrigin: "ws://localhost:8081",
  mediaAddress: "127.0.0.1",
  turnIp: "127.0.0.1",
  turnPort: "3478",
  rtcPort: "40000",
  rtcMaxPort: "40003",
  mediaWorkers: "1",
  allowedOrigins: "http://localhost:3005",
  email: { mode: "skip", id: "", secret: "" },
  github: { mode: "skip", id: "", secret: "" },
  google: { mode: "skip", id: "", secret: "" },
};
let step = 0;
let state;
let saving = false;

function element(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}

function message(value) {
  error.textContent = value;
  error.hidden = !value;
}

async function request(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: data === undefined ? {} : { "content-type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Setup could not complete this operation");
  return result;
}

function valueFor(name, value) {
  const [parent, child] = name.split(".");
  if (child) {
    if (value !== undefined) values[parent][child] = value;
    return values[parent][child];
  }
  if (value !== undefined) values[name] = value;
  return values[name];
}

function field(name, title, options = {}, parent = fields) {
  const label = element("label", "account-field");
  label.append(element("span", "field-label", title));
  const input = element("input", "input login-input auth-input");
  Object.assign(input, {
    name,
    type: options.type || "text",
    required: options.required !== false,
    maxLength: 2048,
    value: valueFor(name) || "",
    autocomplete: "off",
    spellcheck: false,
    ...options,
  });
  input.addEventListener("input", () => {
    valueFor(name, input.value);
    if (name === "hostname") {
      values.consoleOrigin = `https://${input.value.trim()}`;
      values.apiOrigin = `https://${input.value.trim()}`;
      values.signalingOrigin = `wss://${input.value.trim()}`;
      for (const address of ["consoleOrigin", "apiOrigin", "signalingOrigin"]) {
        const control = form.elements.namedItem(address);
        if (control) control.value = values[address];
      }
    }
  });
  label.append(input);
  parent.append(label);
}

function select(name, title, choices, changed) {
  const label = element("label", "account-field");
  label.append(element("span", "field-label", title));
  const input = element("select", "input");
  input.name = name;
  for (const [value, content] of choices) {
    const option = element("option", "", content);
    option.value = value;
    input.append(option);
  }
  input.value = valueFor(name);
  input.addEventListener("change", () => {
    valueFor(name, input.value);
    changed?.();
    render();
  });
  label.append(input);
  fields.append(label);
}

function note(content, parent = fields) {
  parent.append(element("p", "account-note", content));
}

function integration(name, title, configured, names) {
  select(`${name}.mode`, title, [
    ...(configured ? [["keep", "Keep current credentials"]] : []),
    ["skip", "Skip"],
    ["configure", "Configure now"],
  ]);
  if (values[name].mode === "configure") {
    field(`${name}.id`, names[0], { type: name === "email" ? "password" : "text" });
    field(`${name}.secret`, names[1], { type: name === "email" ? "text" : "password" });
  }
}

function summary(title, value, parent) {
  const row = element("div");
  row.append(element("dt", "", title), element("dd", "", value));
  parent.append(row);
}

function render() {
  fields.replaceChildren();
  const steps = document.querySelector("#steps");
  steps.replaceChildren();
  labels.forEach((label, index) => {
    const item = element("span", "", `${index + 1}. ${label}`);
    if (index === step) item.setAttribute("aria-current", "step");
    steps.append(item);
  });
  back.hidden = step === 0;
  next.textContent = step === 3 ? "Generate configuration" : "Continue";
  if (step === 0) {
    select(
      "mode",
      "Where will RelayRTC run?",
      [
        ["local", "On this computer"],
        ["public", "Public server"],
      ],
      () => {
        const local = values.mode === "local";
        values.hostname = "";
        values.consoleOrigin = local ? "http://localhost:3002" : "";
        values.apiOrigin = local ? "http://localhost:8080" : "";
        values.signalingOrigin = local ? "ws://localhost:8081" : "";
        values.mediaAddress = local ? "127.0.0.1" : "";
        values.turnIp = local ? "127.0.0.1" : "";
        values.allowedOrigins = local ? "http://localhost:3005" : "";
      },
    );
    let addressContainer = fields;
    if (values.mode === "public") {
      field("hostname", "Hostname or IP address", {
        placeholder: "relayrtc.example.com",
        maxLength: 253,
      });
      const details = element("details");
      details.append(element("summary", "", "Separate API or signaling addresses (optional)"));
      addressContainer = element("div");
      details.append(addressContainer);
      fields.append(details);
    }
    field(
      "consoleOrigin",
      "Console address",
      { placeholder: "https://relayrtc.example.com", type: "url" },
      addressContainer,
    );
    field(
      "apiOrigin",
      "API address",
      { placeholder: "https://api.example.com", type: "url" },
      addressContainer,
    );
    field(
      "signalingOrigin",
      "Signaling address",
      { placeholder: "wss://signal.example.com", type: "url" },
      addressContainer,
    );
    note(
      values.mode === "local"
        ? "Local defaults are ready to use. PostgreSQL, rooms and streaming are included."
        : "By default, the console, API and signaling share your hostname. Configure DNS and an HTTPS reverse proxy with API and WebSocket routes. The wizard does not issue certificates.",
    );
    field("allowedOrigins", "Other browser application origins (optional)", {
      required: false,
      placeholder: "https://app.example.com",
    });
    note("Separate additional origins with commas. The console origin is included automatically.");
  } else if (step === 1) {
    field("mediaAddress", "mediasoup announced hostname or IP", { placeholder: "203.0.113.10" });
    field("turnIp", "coturn public IP", { placeholder: "203.0.113.10" });
    note(
      "For a server, use addresses reachable by your callers. Generated TURN credentials are managed automatically.",
    );
    const details = element("details");
    details.append(element("summary", "", "Advanced media settings"));
    const advanced = element("div");
    field(
      "rtcPort",
      "First mediasoup TCP/UDP port",
      { type: "number", min: "1024", max: "65535" },
      advanced,
    );
    field(
      "rtcMaxPort",
      "Last mediasoup TCP/UDP port",
      { type: "number", min: "1024", max: "65535" },
      advanced,
    );
    field("mediaWorkers", "mediasoup workers", { type: "number", min: "1", max: "16" }, advanced);
    field(
      "turnPort",
      "coturn listening port",
      { type: "number", min: "1024", max: "65535" },
      advanced,
    );
    note(
      "TURN defaults to 3478 TCP/UDP and relay ports 49160-49200 UDP. Open your configured mediasoup range, TURN ports and streaming ingest ports in the server firewall.",
      advanced,
    );
    details.append(advanced);
    fields.append(details);
  } else if (step === 2) {
    integration("email", "Resend email", state.emailConfigured, [
      "Resend API key",
      "Sender address, such as RelayRTC <hello@example.com>",
    ]);
    note(
      "Skip email to disable verification emails, password-reset emails, email changes and email invitations. You can configure it later.",
    );
    integration("github", "GitHub sign-in", state.githubConfigured, [
      "GitHub client ID",
      "GitHub client secret",
    ]);
    integration("google", "Google sign-in", state.googleConfigured, [
      "Google client ID",
      "Google client secret",
    ]);
    note(
      `OAuth callback addresses use ${values.consoleOrigin}/api/auth/callback/github or /google.`,
    );
  } else {
    const overview = element("dl", "setup-summary");
    summary("Console", values.consoleOrigin, overview);
    summary("API", values.apiOrigin, overview);
    summary("Signaling", values.signalingOrigin, overview);
    summary("Database", "PostgreSQL (included)", overview);
    summary(
      "Media",
      `mediasoup at ${values.mediaAddress}, ports ${values.rtcPort}-${values.rtcMaxPort}`,
      overview,
    );
    summary("TURN", `coturn at ${values.turnIp}`, overview);
    summary("Streaming", "Included with recording workers and private storage", overview);
    summary(
      "Email",
      values.email.mode === "skip" ? "Skipped. No emails will be sent." : "Enabled",
      overview,
    );
    summary(
      "Sign-in",
      [
        values.github.mode !== "skip" ? "GitHub" : "",
        values.google.mode !== "skip" ? "Google" : "",
        "Email and password",
      ]
        .filter(Boolean)
        .join(", "),
      overview,
    );
    fields.append(overview);
    note(
      "Database passwords, signing keys, encryption keys, storage and TURN secrets are generated independently and saved in your private .env file. Existing secrets are preserved when you return to this wizard.",
    );
    if (state.configured)
      note(
        "This updates saved configuration. Apply it during a maintenance window because recreating services interrupts active calls and streams.",
      );
  }
}

back.addEventListener("click", () => {
  if (!saving && step > 0) {
    step -= 1;
    message("");
    render();
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  message("");
  if (step < 3) {
    step += 1;
    render();
    document.querySelector("#title").focus();
    return;
  }
  saving = true;
  fields.disabled = true;
  next.disabled = true;
  back.disabled = true;
  next.textContent = "Saving configuration...";
  form.setAttribute("aria-busy", "true");
  try {
    const result = await request("/api/generate", values);
    form.hidden = true;
    document.querySelector("#steps").hidden = true;
    document.querySelector("#title").textContent = "Ready to start RelayRTC";
    document.querySelector("#description").textContent =
      "Your rooms and streaming configuration is saved.";
    document.querySelector("#complete").hidden = false;
    document.querySelector("#result").textContent =
      `After the stack starts, open ${result.consoleOrigin} and create your account. ${result.emailEnabled ? "Email delivery is configured." : "Email delivery is skipped. No emails will be sent."}`;
    values.email = { mode: "skip", id: "", secret: "" };
    values.github = { mode: "skip", id: "", secret: "" };
    values.google = { mode: "skip", id: "", secret: "" };
    fields.replaceChildren();
  } catch (cause) {
    message(cause.message);
  } finally {
    saving = false;
    fields.disabled = false;
    next.disabled = false;
    back.disabled = false;
    next.textContent = "Generate configuration";
    form.removeAttribute("aria-busy");
  }
});

document.querySelector("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("cd relayrtc\ndocker compose up -d --remove-orphans");
    document.querySelector("#copy").textContent = "Copied";
  } catch {
    message("Copy the two commands shown above into your terminal.");
  }
});
document.querySelector("#finish").addEventListener("click", async () => {
  try {
    await request("/api/finish", {});
    document.querySelector("#finish").disabled = true;
    document.querySelector("#finish").textContent = "Setup closed. You can close this tab.";
  } catch (cause) {
    message(cause.message);
  }
});

async function initialize() {
  try {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (token) {
      await request("/api/session", { token });
      history.replaceState(null, "", "/");
    }
    state = await request("/api/state");
    Object.assign(values, state.settings);
    if (values.mode === "public" && values.consoleOrigin)
      values.hostname = new URL(values.consoleOrigin).host;
    values.email.mode = state.emailConfigured ? "keep" : "skip";
    values.github.mode = state.githubConfigured ? "keep" : "skip";
    values.google.mode = state.googleConfigured ? "keep" : "skip";
    form.hidden = false;
    render();
  } catch (cause) {
    message(cause.message);
  } finally {
    document.querySelector("#loading").hidden = true;
  }
}
void initialize();
