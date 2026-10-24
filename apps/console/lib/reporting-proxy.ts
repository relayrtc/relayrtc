import { accountOrigin } from "./account-proxy";

// Reporting is read-only. Authorization and retained-history rules remain
// with the existing API, including when its report cache has an entry.
export async function proxyReportingRequest(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const path = incoming.pathname.slice("/api/reporting/".length);
  const headers = new Headers({ "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  if (!incoming.pathname.startsWith("/api/reporting/") || !/^(?:projects\/[A-Za-z0-9_-]{1,128}\/(?:analytics|usage)|organizations\/[A-Za-z0-9_-]{1,128}\/(?:usage|quota))$/.test(path)) return Response.json({ message: "Unknown reporting path." }, { status: 404, headers });
  const upstream = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "user-agent", "origin"]) { const value = request.headers.get(name); if (value) upstream.set(name, value); }
  try {
    const response = await fetch(new URL(`/v1/${path}${incoming.search}`, accountOrigin()), { method: "GET", headers: upstream, cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(35000)]) });
    for (const name of ["content-type", "retry-after", "x-request-id", "x-relayrtc-api-version"]) { const value = response.headers.get(name); if (value) headers.set(name, value); }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json({ message: "Reporting services are temporarily unavailable. Please try again." }, { status: 503, headers });
  }
}
