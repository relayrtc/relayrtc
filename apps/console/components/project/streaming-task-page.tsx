"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StreamingHeader } from "./stream-ui";
import { useStreamWorkspace } from "./stream-workspace";

/** Creation is a navigable route: refresh, Back and copied URLs retain the task. */
export function useStreamingTask(segment = "new") {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const active = pathname.endsWith(`/${segment}`);
  const base = active ? pathname.slice(0, -(segment.length + 1)) : pathname;
  const query = search.toString();
  const backHref = `${base}${query ? `?${query}` : ""}`;
  const setOpen = (open: boolean) => {
    if (open) router.push(`${base}/${segment}${query ? `?${query}` : ""}`);
    else {
      router.replace(backHref);
      router.refresh();
    }
  };
  return { active, setOpen, backHref };
}

export function StreamingTaskPage({
  title,
  description,
  children,
  backHref,
  guidance,
  onBack,
  wide = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  backHref: string;
  guidance?: ReactNode;
  onBack?: (() => void) | undefined;
  wide?: boolean;
}) {
  const workspace = useStreamWorkspace();
  return (
    <section className="w-full min-w-0 space-y-5">
      {onBack ? (
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
      ) : (
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back
        </Link>
      )}
      <div className="space-y-2">
        {workspace && <p className="text-sm text-muted-foreground">{workspace.stream.name}</p>}
        <StreamingHeader title={title} description={description} heading="h1" />
      </div>
      <div
        className={
          wide
            ? "w-full"
            : guidance
              ? "grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(15rem,1fr)]"
              : "max-w-3xl"
        }
      >
        <div
          className={
            wide
              ? "min-w-0"
              : "min-w-0 space-y-5 rounded-xl border border-border/70 bg-card/30 p-4 sm:p-5 [&_form]:p-0 [&_input:not([type=checkbox]):not([type=radio])]:h-10 [&_input:not([type=checkbox]):not([type=radio])]:rounded-lg [&_button]:rounded-lg [&_[data-slot=select-trigger]]:rounded-lg [&_button[type=submit]]:h-10"
          }
        >
          {children}
        </div>
        {guidance && !wide && (
          <aside className="rounded-xl border border-border/70 bg-card/30 p-4 sm:p-5">
            <h2 className="mb-2 text-sm font-medium">Before you start</h2>
            <div className="text-sm leading-relaxed text-muted-foreground">{guidance}</div>
          </aside>
        )}
      </div>
    </section>
  );
}
