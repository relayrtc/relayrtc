"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { accountRequest, AccountApiError } from "@/lib/account-api";
import { authHref } from "@/lib/auth-query";
import type { AccountOverview } from "@/lib/auth-types";

type AccountContext = { account: AccountOverview; refreshAccount: () => Promise<void>; signOut: (returnTo?: string) => Promise<void>; expireSession: () => void; endSession: (returnTo?: string) => void };
const Context = createContext<AccountContext | null>(null);
const channelName = "relayrtc-account-session";

export function AccountProvider({ initialAccount, children }: { initialAccount: AccountOverview; children: ReactNode }) {
  const [account, setAccount] = useState(initialAccount);
  const [expired, setExpired] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const expireSession = useCallback(() => {
    setExpired(true);
    window.location.replace(authHref("/auth/login", window.location.pathname + window.location.search));
  }, []);
  const refreshAccount = useCallback(async () => {
    try {
      // Let Better Auth renew its HTTP-only cookie according to the API's
      // session policy; account overview reads intentionally don't renew it.
      const session = await accountRequest<{ user: { id: string } } | null>("/api/auth/get-session?disableCookieCache=true");
      if (!session) { expireSession(); return; }
      const updated = await accountRequest<AccountOverview>("/api/account");
      if (updated.user.id !== initialAccount.user.id) { window.location.reload(); return; }
      setAccount(updated);
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) expireSession();
      throw error;
    }
  }, [initialAccount.user.id, expireSession]);
  const endSession = useCallback((returnTo?: string) => {
    channel.current?.postMessage("signed-out");
    setExpired(true);
    window.location.replace(returnTo ? authHref("/auth/login", returnTo) : "/auth/login");
  }, []);
  const signOut = useCallback(async (returnTo?: string) => {
    await accountRequest("/api/auth/sign-out", {});
    endSession(returnTo);
  }, [endSession]);
  useEffect(() => {
    let lastCheck = 0;
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < 30000) return;
      lastCheck = Date.now();
      void refreshAccount().catch(() => { /* A temporary outage does not sign out a valid session. */ });
    };
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel(channelName);
      channel.current.onmessage = event => { if (event.data === "signed-out") expireSession(); else check(); };
    }
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    check();
    return () => { channel.current?.close(); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [refreshAccount, expireSession]);
  return <Context.Provider value={{ account, refreshAccount, signOut, expireSession, endSession }}>{expired ? null : children}</Context.Provider>;
}

export function useAccount() {
  const context = useContext(Context);
  if (!context) throw new Error("useAccount must be used within AccountProvider");
  return context;
}
