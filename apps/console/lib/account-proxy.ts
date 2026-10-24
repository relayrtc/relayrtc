export function accountOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.RELAYRTC_API_URL;
  if (!configured && environment.NODE_ENV === "production") throw new Error("RELAYRTC_API_URL is required.");
  const url = new URL(configured ?? `http://localhost:${environment.API_PORT ?? "8080"}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("RELAYRTC_API_URL must be an HTTP(S) origin.");
  return url.origin;
}

// The existing Fastify account module remains the only auth authority.
// Preserve its individual cookies, origin checks, redirects and rate limits.
export async function proxyAccountRequest(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const path = incoming.pathname;
  if ((!path.startsWith("/api/auth/") && path !== "/api/account" && !path.startsWith("/api/account/")) || /%2f|%5c|\\/i.test(path)) return Response.json({ message: "Invalid account API path." }, { status: 400 });
  const headers = new Headers();
  for (const name of ["cookie", "origin", "content-type", "accept", "user-agent", "sec-fetch-site"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(new URL(`${path}${incoming.search}`, accountOrigin()), {
      method: request.method, headers, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(25000),
      ...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.text() }),
    });
    const output = new Headers({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
    for (const name of ["content-type", "location", "retry-after", "x-request-id", "content-disposition"]) {
      const value = response.headers.get(name);
      if (value) output.set(name, value);
    }
    for (const cookie of response.headers.getSetCookie()) output.append("set-cookie", cookie);
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return Response.json({ message: "Account services are temporarily unavailable. Please try again." }, { status: 503, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
  }
}
