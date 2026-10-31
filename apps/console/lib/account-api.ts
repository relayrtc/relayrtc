export class AccountApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  constructor(message: string, status: number, code?: string, retryAfter?: number) {
    super(message); this.name = "AccountApiError"; this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}

const readCooldowns = new Map<string, { until: number; error: AccountApiError }>();

export async function accountRequest<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, options?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; idempotencyKey?: string }): Promise<T> {
  const pathname = path.split("?")[0];
  if (!/^\/api\/(?:auth\/|account(?:\/|$)|streaming\/|reporting\/)/.test(pathname) || pathname.includes("\\") || pathname.includes("..")) throw new Error("Invalid account request.");
  const method = options?.method ?? (body === undefined ? "GET" : "POST");
  const readScope = method === "GET" && typeof window !== "undefined" ? pathname.replace(/\/(projects|rooms|sessions)\/[^/]+/g, "/$1/:id") : null;
  if (readScope) {
    const cooldown = readCooldowns.get(readScope);
    if (cooldown && cooldown.until > Date.now()) throw new AccountApiError(cooldown.error.message, 429, cooldown.error.code, Math.ceil((cooldown.until - Date.now()) / 1000));
    readCooldowns.delete(readScope);
  }
  const timeout = pathname.startsWith("/api/reporting/") ? 35000 : 25000;
  let response: Response;
  try {
    response = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(options?.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AccountApiError("Unable to reach account services. Please try again.", 503);
  }
  const { parsed, payload } = await response.json().then((value: unknown) => ({ parsed: true, payload: value })).catch(() => ({ parsed: false, payload: null }));
  if (!response.ok) {
    const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
    const error = typeof record.error === "object" && record.error !== null ? record.error as Record<string, unknown> : record;
    const message = typeof error.message === "string" ? error.message : typeof error.description === "string" ? error.description : "Account services are temporarily unavailable. Please try again.";
    const retry = Number(response.headers.get("retry-after"));
    const failure = new AccountApiError(message, response.status, typeof error.code === "string" ? error.code : undefined, Number.isFinite(retry) && retry > 0 ? retry : response.status === 429 ? 5 : undefined);
    if (response.status === 429 && readScope) {
      for (const [key, value] of readCooldowns) if (value.until <= Date.now()) readCooldowns.delete(key);
      readCooldowns.set(readScope, { until: Date.now() + (failure.retryAfter ?? 5) * 1000, error: failure });
    }
    throw failure;
  }
  if (!parsed && response.status !== 204) throw new AccountApiError("Account services returned an unexpected response. Please try again.", 503);
  return payload as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof AccountApiError && error.retryAfter) return `${error.message} Try again in ${String(error.retryAfter)} seconds.`;
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
