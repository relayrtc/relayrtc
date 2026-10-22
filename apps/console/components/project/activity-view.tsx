import Link from "next/link";
import type { ReactNode } from "react";
import { Panel } from "@/components/page/panel";
import { CopyButton } from "@/components/page/copy-button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const activityLabels = {
  rooms: "Rooms",
  streams: "Livestreams",
  assets: "Recordings & clips",
  sources: "External sources",
};

export function ActivityTabs({
  base,
  view,
  environmentId,
}: {
  base: string;
  view: string;
  environmentId?: string;
}) {
  return (
    <nav aria-label="Activity type" className="flex gap-5 overflow-x-auto border-b">
      {Object.entries(activityLabels).filter(([id]) => view === "assets" ? id === "assets" : id !== "assets").map(([id, label]) => (
        <Link
          key={id}
          href={`${base}?${new URLSearchParams({ view: id, ...(environmentId ? { environmentId } : {}) })}`}
          aria-current={view === id ? "page" : undefined}
          className={cn(
            "shrink-0 border-b-2 px-1 pb-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            view === id
              ? "border-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function ActivityStatus({ value }: { value: string }) {
  return (
    <Badge variant="secondary" className={cn("capitalize", ["live", "ready", "connected", "running"].includes(value) && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", ["failed", "error"].includes(value) && "bg-destructive/10 text-destructive", ["starting", "queued", "reconnecting", "finalizing"].includes(value) && "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
      {value.replaceAll("_", " ")}
    </Badge>
  );
}

export function ResourceIdentity({ id }: { id: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 break-all text-xs text-muted-foreground">{id}</code>
      <CopyButton value={id} label="Copy resource ID" />
    </span>
  );
}

export function ActivityFields({ fields }: { fields: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words text-sm">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ActivitySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel>
      <h2 className="mb-4 text-base font-medium">{title}</h2>
      {children}
    </Panel>
  );
}

export function ActivityError({ value }: { value: string | null }) {
  if (!value) return null;
  const message = /^[A-Z][A-Z0-9_:. -]{0,159}$/.test(value)
    ? value
    : "An error was reported. Use this resource ID to find the corresponding service logs.";
  return (
    <p role="status" className="mt-2 break-words text-sm text-destructive">
      {message}
    </p>
  );
}

export function activityDate(value: Date | null) {
  return value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "UTC",
      }).format(value) + " UTC"
    : "—";
}

export function ActivityPagination({
  page,
  hasNext,
  href,
}: {
  page: number;
  hasNext: boolean;
  href: (page: number) => string;
}) {
  if (!page && !hasNext) return null;
  return (
    <nav aria-label="Activity pagination" className="flex flex-wrap items-center gap-4 text-sm">
      {page > 0 && (
        <Link className="underline" href={href(page - 1)}>
          Previous
        </Link>
      )}
      <span className="text-muted-foreground">Page {page + 1}</span>
      {hasNext && (
        <Link className="underline" href={href(page + 1)}>
          Next
        </Link>
      )}
    </nav>
  );
}
