import { RoomError } from "./room-errors.js";
import type { RoomReconnectOptions } from "./room.js";

export function recoveryOptions(
  options: false | RoomReconnectOptions | undefined,
): Required<RoomReconnectOptions> {
  const value = options === false ? {} : (options ?? {});
  const result = {
    maxAttempts: value.maxAttempts ?? 6,
    timeoutMs: value.timeoutMs ?? 25_000,
    initialDelayMs: value.initialDelayMs ?? 250,
    maxDelayMs: value.maxDelayMs ?? 4000,
  };
  if (
    !Object.values(result).every(Number.isInteger) ||
    result.maxAttempts < 1 ||
    result.maxAttempts > 20 ||
    result.timeoutMs < 1000 ||
    result.timeoutMs > 120_000 ||
    result.initialDelayMs < 0 ||
    result.maxDelayMs < 1 ||
    result.maxDelayMs > 30_000 ||
    result.initialDelayMs > result.maxDelayMs
  )
    throw new RoomError(
      "INVALID_CONFIGURATION",
      "Provide valid reconnect attempt, deadline, and backoff limits",
    );
  return result;
}

export function recoverable(error: RoomError): boolean {
  return (
    [
      "CONNECTION_FAILED",
      "CONNECTION_CLOSED",
      "REQUEST_TIMEOUT",
      "NOT_CONNECTED",
      "ICE_CONNECTION_LOST",
      "ICE_RECOVERY_FAILED",
      "SESSION_CONFLICT",
      "RTC_STATE_CHANGED",
    ].includes(error.code) ||
    (error.code === "SERVICE_UNAVAILABLE" && error.retryable)
  );
}

export function duringRecovery<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason instanceof RoomError
          ? signal.reason
          : new RoomError("NOT_CONNECTED", "Room recovery was cancelled"),
      );
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(
          error instanceof Error
            ? error
            : new RoomError("RECONNECT_FAILED", "Room recovery failed"),
        );
      },
    );
  });
}

async function waitUntilOnline(signal: AbortSignal): Promise<void> {
  if (typeof window === "undefined" || typeof navigator === "undefined" || navigator.onLine) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      window.removeEventListener("online", online);
      signal.removeEventListener("abort", abort);
    };
    const online = (): void => {
      if (!navigator.onLine) return;
      cleanup();
      resolve();
    };
    const abort = (): void => {
      cleanup();
      reject(
        signal.reason instanceof RoomError
          ? signal.reason
          : new RoomError("NOT_CONNECTED", "Room recovery was cancelled"),
      );
    };
    window.addEventListener("online", online);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else online();
  });
}

export async function recoverRoom(
  operation: (signal: AbortSignal) => Promise<void>,
  options: Required<RoomReconnectOptions>,
  controller: AbortController,
  initialError: RoomError,
  onAttempt: (attempt: number, delayMs: number, error: RoomError) => void,
): Promise<number> {
  const timer = setTimeout(() => {
    controller.abort(new RoomError("RECONNECT_FAILED", "The room recovery deadline was reached"));
  }, options.timeoutMs);
  let failure = initialError;
  try {
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      await waitUntilOnline(controller.signal);
      const delayMs = Math.round(
        Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** (attempt - 1)) *
          (0.75 + Math.random() * 0.25),
      );
      onAttempt(attempt, delayMs, failure);
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(delay);
          reject(
            controller.signal.reason instanceof RoomError
              ? controller.signal.reason
              : new RoomError("NOT_CONNECTED", "Room recovery was cancelled"),
          );
        };
        const delay = setTimeout(() => {
          controller.signal.removeEventListener("abort", abort);
          resolve();
        }, delayMs);
        if (controller.signal.aborted) abort();
        else controller.signal.addEventListener("abort", abort, { once: true });
      });
      await waitUntilOnline(controller.signal);
      try {
        await duringRecovery(operation(controller.signal), controller.signal);
        return attempt;
      } catch (error) {
        failure =
          error instanceof RoomError
            ? error
            : new RoomError("ICE_RECOVERY_FAILED", "The room connection could not recover", true);
        if (controller.signal.aborted || !recoverable(failure)) throw failure;
      }
    }
    if (failure.code === "SESSION_CONFLICT") throw failure;
    throw new RoomError(
      "RECONNECT_FAILED",
      "The room could not recover within the configured attempt limit",
    );
  } finally {
    clearTimeout(timer);
  }
}
