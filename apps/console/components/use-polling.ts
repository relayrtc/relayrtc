"use client";

import { useEffect } from "react";
import { AccountApiError } from "@/lib/account-api";

export function usePolling(refresh: (signal?: AbortSignal) => Promise<unknown>, enabled: boolean, interval: number) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false, retryAt = 0, failures = 0;
    const load = () => {
      if (pending || document.visibilityState !== "visible" || Date.now() < retryAt) return;
      pending = true;
      void refresh(controller.signal).then(() => { failures = 0; retryAt = 0; }).catch(error => {
        if (controller.signal.aborted) return;
        failures++;
        const delay = error instanceof AccountApiError && error.retryAfter ? error.retryAfter * 1000 : Math.min(30000, interval * 2 ** failures);
        retryAt = Date.now() + delay;
      }).finally(() => { pending = false; });
    };
    const timer = setInterval(load, interval);
    document.addEventListener("visibilitychange", load);
    return () => { clearInterval(timer); controller.abort(); document.removeEventListener("visibilitychange", load); };
  }, [refresh, enabled, interval]);
}
