// Next's self-hosted request URL can contain its bind address. The Host header
// retains the address used by the browser, including a remapped Docker port.
export function requestOrigin(request: Request): string {
  const incoming = new URL(request.url);
  const host = request.headers.get("host");
  if (!host) return incoming.origin;
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwarded === "http" || forwarded === "https" ? `${forwarded}:` : incoming.protocol;
  try {
    const publicUrl = new URL(`${protocol}//${host}`);
    if (publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) return incoming.origin;
    return publicUrl.origin;
  } catch {
    return incoming.origin;
  }
}
