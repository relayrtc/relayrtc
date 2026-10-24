import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { accountOrigin } from "./account-proxy";
import type { AccountOverview } from "./auth-types";

export const getServerAccount = cache(async (): Promise<AccountOverview | null> => {
  const jar = await cookies();
  const cookie = jar.getAll().filter(item => /^(?:__Secure-)?better-auth\.session_token$/.test(item.name)).map(item => `${item.name}=${item.value}`).join("; ");
  if (!cookie) return null;
  try {
    const response = await fetch(new URL("/api/account", accountOrigin()), {
      headers: { cookie, accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error();
    const account = await response.json() as AccountOverview;
    if (!account?.user?.id || !Array.isArray(account.accounts)) throw new Error();
    return account;
  } catch { throw new Error("Account services are temporarily unavailable. Please try again."); }
});
