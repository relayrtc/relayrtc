"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { accountRequest, AccountApiError, errorMessage } from "@/lib/account-api";
import { useAccount } from "./account-provider";
import { useWorkspace } from "./workspace-provider";

export function useWorkspaceResource<T>(path: string | null) {
  const { expireSession } = useAccount();
  const { revision } = useWorkspace();
  const [loaded, setLoaded] = useState<{ path: string; data: T } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const inFlight = useRef<{ path: string; sequence: number; signal?: AbortSignal; promise: Promise<T | undefined> } | null>(null);
  const refresh = useCallback((signal?: AbortSignal): Promise<T | undefined> => {
    if (signal && path && inFlight.current?.path === path && !inFlight.current.signal?.aborted) return inFlight.current.promise;
    const current = ++sequence.current; setLoading(true); setError("");
    if (!path) { setLoaded(null); setLoading(false); return Promise.resolve(undefined); }
    const promise = (async () => {
      try {
        const data = await accountRequest<T>(path, undefined, signal);
        if (current === sequence.current) setLoaded({ path, data });
        return data;
      } catch (error) {
        if (signal?.aborted || current !== sequence.current) return;
        if (error instanceof AccountApiError && [401, 403, 404].includes(error.status)) setLoaded(null);
        setError(errorMessage(error));
        if (error instanceof AccountApiError && error.status === 401) expireSession();
        throw error;
      } finally {
        if (!signal?.aborted && current === sequence.current) setLoading(false);
        if (inFlight.current?.sequence === current) inFlight.current = null;
      }
    })();
    inFlight.current = { path, sequence: current, signal, promise };
    return promise;
  }, [path, expireSession]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal).catch(() => {}); return () => controller.abort(); }, [refresh, revision]);
  return { data: loaded?.path === path ? loaded.data : null, loading, error, refresh };
}
