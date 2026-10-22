"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ActivityRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !pending) startTransition(() => router.refresh());
    }, 15000);
    return () => clearInterval(timer);
  }, [router, pending]);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw className={pending ? "animate-spin" : ""} />
      {pending ? "Refreshing..." : "Refresh"}
    </Button>
  );
}
