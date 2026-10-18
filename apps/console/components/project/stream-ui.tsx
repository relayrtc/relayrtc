"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStreamWorkspace } from "./stream-workspace";

export function StreamingHeader({
  title,
  description,
  actions,
  heading,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  heading?: "h1" | "h2";
  className?: string;
}) {
  const workspace = useStreamWorkspace();
  const Heading = heading ?? (workspace ? "h2" : "h1");
  return (
    <header
      className={cn("flex flex-col justify-between gap-4 sm:flex-row sm:items-start", className)}
    >
      <div className="min-w-0">
        <Heading className="text-2xl font-semibold tracking-tight">{title}</Heading>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 [&_button]:h-9 [&_button]:rounded-lg [&_button]:px-3.5 [&_button]:text-xs">
          {actions}
        </div>
      )}
    </header>
  );
}

export function StreamToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-xl border border-border/70 bg-card/30 p-3 [&_button]:rounded-lg [&_input]:h-9 [&_input]:rounded-lg [&_[data-slot=select-trigger]]:h-9 [&_[data-slot=select-trigger]]:rounded-lg">
      {children}
    </div>
  );
}

export function StreamEmptyState({
  title,
  description,
  icon: Icon = Radio,
  actions,
  className,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center rounded-xl border border-dashed border-border/80 bg-card/20 px-5 py-12 text-center",
        className,
      )}
    >
      <span className="mb-4 grid size-12 place-items-center rounded-xl border border-border/70 bg-background text-muted-foreground">
        <Icon className="size-5" strokeWidth={1.5} />
      </span>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      {actions && (
        <div className="mt-5 flex flex-wrap justify-center gap-2 [&_a]:rounded-lg [&_button]:rounded-lg">
          {actions}
        </div>
      )}
    </div>
  );
}

export function StreamFieldSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "min-w-0 space-y-4 rounded-xl border border-border/70 bg-card/30 p-4 sm:p-5",
        className,
      )}
    >
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="min-w-0 space-y-4 [&_label]:leading-relaxed [&_input:not([type=radio]):not([type=hidden])]:h-10 [&_input]:rounded-lg [&_[data-slot=select-trigger]]:rounded-lg [&_[data-slot=select-trigger]]:h-10">
        {children}
      </div>
    </section>
  );
}
