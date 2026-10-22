/** Safe callback error metadata. Never retains endpoint bodies, URLs or causes. */
export class StreamingRequestError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(message: string, error?: unknown) {
    super(message);
    this.name = "StreamingRequestError";
    const input = typeof error === "object" && error !== null
      ? error as { status?: unknown; statusCode?: unknown; retryAfterMs?: unknown } : {};
    const status = input.status ?? input.statusCode;
    this.status = typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600 ? status : null;
    this.retryAfterMs = typeof input.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs) && input.retryAfterMs >= 0
      ? Math.min(2147483647, Math.ceil(input.retryAfterMs)) : null;
  }
}

/** Per-client cooldown shared by polling, recovery and manual retries. */
export class StreamingBackoff {
  private failures = 0;
  private until = 0;
  remaining() { return Math.max(0, this.until - Date.now()); }
  delay(normal: number) { return Math.max(normal, this.remaining()); }
  reset() { this.failures = 0; this.until = 0; }
  succeed() { if (this.remaining() === 0) this.failures = 0; }
  fail(message: string, cause: unknown, interval: number) {
    const error = new StreamingRequestError(message, cause);
    this.failures = Math.min(7, this.failures + 1);
    const delay = Math.max(error.retryAfterMs ?? 0, Math.min(60000, Math.max(1000, interval) * 2 ** (this.failures - 1)));
    this.until = Math.max(this.until, Date.now() + delay);
    return error;
  }
}
