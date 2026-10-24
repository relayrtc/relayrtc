export class AccountApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  constructor(message: string, status: number, code?: string, retryAfter?: number) {
    super(message); this.name = "AccountApiError"; this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}

export async function accountRequest<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, options?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; idempotencyKey?: string }): Promise<T> {
  const pathname = path.split("?")[0];
  if (!/^\/api\/(?:auth\/|account(?:\/|$)|streaming\/|reporting\/)/.test(pathname) || pathname.includes("\\") || pathname.includes("..")) throw new Error("Invalid account request.");
  const timeout = pathname.startsWith("/api/reporting/") ? 35000 : 25000;
  let response: Response;
  try {
    response = await fetch(path, {
      method: options?.method ?? (body === undefined ? "GET" : "POST"), credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(options?.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AccountApiError("Unable to reach account services. Please try again.", 503);
  }
  let parsed = false;
  const payload = await response.json().then(value => { parsed = true; return value; }).catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? payload;
    const message = typeof error?.message === "string" ? error.message : typeof error?.description === "string" ? error.description : "Account services are temporarily unavailable. Please try again.";
    const retry = Number(response.headers.get("retry-after"));
    throw new AccountApiError(message, response.status, error?.code, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  if (!parsed && response.status !== 204) throw new AccountApiError("Account services returned an unexpected response. Please try again.", 503);
  return payload as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof AccountApiError && error.retryAfter) return `${error.message} Try again in ${error.retryAfter} seconds.`;
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
