const base = "https://console.invalid";
const trackingKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

export function authSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first) params.set(key, first);
  }
  return params;
}

// Destinations stay inside this console, including after OAuth and MFA.
export function safeRedirect(value: string | null | undefined, fallback = "/rooms"): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return fallback;
  try {
    const url = new URL(value, base);
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== base || path.startsWith("//") || /[\\\u0000-\u001f]/.test(path) || /^\/(?:auth|api|cleanup|_next)(?:\/|$)/.test(path)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}

export function postAuthDestination(params: URLSearchParams): string {
  let destination = params.get("redirect");
  // The existing OAuth MFA hook may wrap the destination in /auth/continue.
  if (destination?.startsWith("/auth/continue?")) {
    try { destination = new URL(destination, base).searchParams.get("redirect"); } catch { destination = null; }
  }
  const url = new URL(safeRedirect(destination), base);
  for (const key of trackingKeys) {
    const value = params.get(key)?.trim();
    if (value && value.length <= 256 && !url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function authHref(path: string, destination: string, extras: Record<string, string> = {}): string {
  const params = new URLSearchParams({ redirect: safeRedirect(destination), ...extras });
  return `${path}?${params}`;
}

export function oauthRedirect(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("The sign-in provider returned an invalid redirect.");
  return parsed.href;
}
