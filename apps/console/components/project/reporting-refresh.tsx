"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

export function ReportingRefresh({
  startedAt,
  endedAt,
  intervalMs = 15000,
}: {
  startedAt: string;
  endedAt: string;
  intervalMs?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden && !pending) startTransition(() => router.refresh());
    };
    const timer = window.setInterval(refresh, intervalMs);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, pending, intervalMs]);
  return (
    <p className="text-xs text-muted-foreground" role="status">
      UTC: {startedAt.replace("T", " ").replace("Z", "")} –{" "}
      {endedAt.replace("T", " ").replace("Z", "")}.
      {pending ? " Updating…" : ` Refreshes every ${intervalMs / 1000}s.`} Reporting may lag
      collection.
    </p>
  );
}
