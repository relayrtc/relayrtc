"use client";

import { useRef, useState } from "react";
import { AccountApiError, errorMessage } from "@/lib/account-api";
import { useAccount } from "./account-provider";

export function useDeveloperMutation(onBusy?: (busy: boolean) => void) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { expireSession } = useAccount();
  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setPending(true); onBusy?.(true); setError("");
    try { await task(); }
    catch (error) { setError(errorMessage(error)); if (error instanceof AccountApiError && error.status === 401) expireSession(); }
    finally { lock.current = false; setPending(false); onBusy?.(false); }
  }
  return { pending, error, run };
}
