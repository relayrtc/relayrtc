"use client";

import { useEffect, useState } from "react";
import { usePolling } from "./use-polling";

export function useDebouncedValue<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return debounced;
}

export function useRealtimeRefresh(refresh: (signal?: AbortSignal) => Promise<unknown>, enabled = true, interval = 10000) {
  usePolling(refresh, enabled, interval);
}

export function useConnectionClock() {
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
