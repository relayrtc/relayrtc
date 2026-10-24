import { accountOrigin } from "./account-proxy";
import { requestOrigin } from "./request-origin";

// Only the public media management API is reachable here. Internal worker,
// gateway and ingest endpoints are deliberately outside this bridge.
const resource = "[A-Za-z0-9_-]{1,128}";
const routes = [
  `streams(?:/${resource}(?:/(?:source-sessions|stop|playback|usage|recording-policy|recordings|buffer-policy|dvr-policy|dvr-playback|clip-window|clips|guest-stage|audience-grants|(?:invites|guest-requests|guests)(?:/${resource}/(?:accept|decline|cancel|approve|reject|leave|remove|mute|join-grant))?|playback-grants(?:/revoke)?|ingest-credentials(?:/${resource}/rotate)?|destinations(?:/${resource}(?:/rotate-secret)?)?))?)?`,
  `recordings(?:/${resource}(?:/(?:stop|playback))?)?`,
  `clips(?:/${resource}(?:/publish)?)?`,
  `assets/${resource}(?:/access-grants(?:/revoke)?)?`,
  `streaming-operations/${resource}`,
  `broadcasts(?:/${resource}(?:/(?:start|stop|mixers|outputs(?:/${resource}/retry)?))?)?`,
  `mixers/${resource}(?:/(?:scenes(?:/${resource})?|activate-scene|stop|overlays(?:/${resource})?))?`,
  `mixer-operations/${resource}`,
  `restream-sources(?:/${resource}(?:/(?:probe|start|stop))?)?`,
  `scheduled-broadcasts(?:/${resource}(?:/(?:start-now|cancel|playback|playback-grants|ingest-credentials))?)?`,
  `schedule-operations/${resource}`,
];
const allowed = new RegExp(`^(?:${routes.join("|")})$`);

export async function proxyStreamingRequest(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const path = incoming.pathname.slice("/api/streaming/".length);
  const output = new Headers({ "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  if (!incoming.pathname.startsWith("/api/streaming/") || !allowed.test(path)) return Response.json({ message: "Unknown media API path." }, { status: 404, headers: output });
  // Preserve the browser's Origin. The API performs its own session, CSRF,
  // membership, environment, permission and idempotency checks.
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== requestOrigin(request)) return Response.json({ message: "A same-origin media request is required." }, { status: 403, headers: output });
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "origin", "content-type", "idempotency-key", "user-agent", "sec-fetch-site"]) {
    const value = request.headers.get(name); if (value) headers.set(name, value);
  }
  try {
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
    const limit = /^mixers\/[A-Za-z0-9_-]+\/overlays$/.test(path) ? 1500000 : 16384;
    if (body && new TextEncoder().encode(body).length > limit) return Response.json({ message: "Media request is too large." }, { status: 413, headers: output });
    const response = await fetch(new URL(`/v1/${path}${incoming.search}`, accountOrigin()), {
      method: request.method, headers, body, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
    });
    for (const name of ["content-type", "retry-after", "x-request-id"]) { const value = response.headers.get(name); if (value) output.set(name, value); }
    if (response.status === 404) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.code === "ROUTE_NOT_FOUND") return Response.json({ code: "STREAMING_UNAVAILABLE", message: "Streaming is not enabled on the API. Enable the streaming services to use media controls." }, { status: 503, headers: output });
    }
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return Response.json({ message: "Media services are temporarily unavailable. Please try again." }, { status: 503, headers: output });
  }
}
