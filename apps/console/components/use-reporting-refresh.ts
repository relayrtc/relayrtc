"use client";
import { usePolling } from "./use-polling";

export function useReportingRefresh(refresh: (signal?: AbortSignal) => Promise<unknown>, enabled = true) {
  usePolling(refresh, enabled, 1000);
}
