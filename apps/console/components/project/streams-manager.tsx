"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Plus,
  Radio,
  RefreshCw,
  Search,
  MoreHorizontal,
  ArrowUpRight,
  Settings2,
  Video,
  Clock3,
  CircleCheck,
  ChevronRight,
} from "lucide-react";
import { listStreamsAction } from "@/actions/streaming";
import { getStreamListActivityAction } from "@/actions/stream-list";
import { SimpleSelect } from "@/components/page/simple-select";
import { CopyButton } from "@/components/page/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { streamWorkspaceHref } from "@/lib/stream-workspace";
import type { ConsoleEnvironment } from "@/lib/console-types";
import type { ConsoleStream } from "@/lib/streaming/contracts";
import type { StreamListActivity } from "@/lib/streaming/stream-list";
import { cn } from "@/lib/utils";

type StreamFilter = "all" | "live" | "scheduled" | "ended";
const filters: { id: StreamFilter; label: string }[] = [
  { id: "all", label: "All streams" },
  { id: "live", label: "Live" },
  { id: "scheduled", label: "Scheduled" },
  { id: "ended", label: "Ended" },
];

function activityFor(
  stream: ConsoleStream,
  activity: Record<string, StreamListActivity>,
): StreamListActivity | null {
  if (stream.status !== "active")
    return {
      category: "ended",
      label: stream.status === "deleting" ? "Retiring" : "Retired",
      timestamp: null,
    };
  return activity[stream.id] ?? null;
}

function activityDetail(activity: StreamListActivity | null) {
  if (!activity) return "Status unavailable";
  if (!activity.timestamp)
    return activity.category === "ready" ? "Ready for your next broadcast" : "";
  const date = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(activity.timestamp));
  return `${activity.category === "scheduled" ? "Starts" : activity.category === "ended" ? "Ended" : "Started"} ${date} UTC`;
}

export function StreamsManager({
  projectId,
  environmentId,
  environments,
  canManage,
  initialRows,
  initialCursor,
  initialError,
  initialActivity,
  initialActivityError,
}: {
  projectId: string;
  environmentId: string;
  environments: readonly ConsoleEnvironment[];
  canManage: boolean;
  initialRows: ConsoleStream[];
  initialCursor: string | null;
  initialError: string | null;
  initialActivity: Record<string, StreamListActivity>;
  initialActivityError: string | null;
}) {
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const base = pathname.slice(0, pathname.lastIndexOf("/streams"));
  const [rows, setRows] = useState(initialRows),
    [cursor, setCursor] = useState(initialCursor),
    [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false),
    [filter, setFilter] = useState("");
  const [activity, setActivity] = useState(initialActivity);
  const [activityError, setActivityError] = useState(initialActivityError);
  const [statusFilter, setStatusFilter] = useState<StreamFilter>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );
  const load = useCallback(
    async (next?: string) => {
      const current = ++revision.current;
      setPending(true);
      try {
        const result = await listStreamsAction({
          projectId,
          environmentId,
          ...(next ? { cursor: next } : {}),
        });
        if (current !== revision.current) return;
        if (result.error) setError(result.error.description);
        else {
          setRows((previous) =>
            next
              ? [...new Map([...previous, ...result.data.data].map((s) => [s.id, s])).values()]
              : result.data.data,
          );
          setCursor(result.data.nextCursor);
          setError(null);
          const status = await getStreamListActivityAction({
            projectId,
            environmentId,
            streamIds: result.data.data.map((stream) => stream.id),
          });
          if (current !== revision.current) return;
          if (status.error) setActivityError(status.error.description);
          else {
            setActivity((previous) => (next ? { ...previous, ...status.data } : status.data));
            setActivityError(null);
          }
        }
      } catch {
        if (current === revision.current) setError("Streams are unavailable. Try again.");
      } finally {
        if (current === revision.current) setPending(false);
      }
    },
    [projectId, environmentId],
  );
  const visible = rows.filter((stream) => {
    const status = activityFor(stream, activity);
    return (
      (statusFilter === "all" || status?.category === statusFilter) &&
      (sourceFilter === "all" || stream.source.kind === sourceFilter) &&
      `${stream.name} ${stream.id} ${stream.source.kind} ${stream.source.kind === "room" ? "WebRTC" : ""}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase())
    );
  });
  const createHref = `${base}/streams/new?environmentId=${encodeURIComponent(environmentId)}`;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Streams</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Create, manage and monitor your live streams.
          </p>
        </div>
        {canManage && (
          <Button
            className="h-10 rounded-lg px-4 text-sm shadow-sm"
            disabled={!environmentId}
            onClick={() => router.push(createHref)}
          >
            <Plus className="size-4" />
            Create stream
          </Button>
        )}
      </header>

      <section
        aria-label="Stream library"
        aria-busy={pending}
        className="min-w-0 rounded-2xl border border-border/70 bg-card/30"
      >
        <div
          aria-label="Filter streams by status"
          className="flex gap-1 overflow-x-auto border-b border-border/70 px-3 pt-2 sm:px-5"
        >
          {filters.map((item) => {
            const count =
              item.id === "all"
                ? rows.length
                : rows.filter((stream) => activityFor(stream, activity)?.category === item.id)
                    .length;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={statusFilter === item.id}
                onClick={() => setStatusFilter(item.id)}
                className={cn(
                  "relative flex shrink-0 items-center gap-2 px-3 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  statusFilter === item.id
                    ? "font-medium text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-[11px] leading-none tabular-nums",
                    statusFilter === item.id ? "bg-muted text-foreground" : "text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 border-b border-border/60 p-4 sm:px-5">
          <div className="relative w-full sm:min-w-40 sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              className="h-10 rounded-lg border-border/70 bg-background pl-9 shadow-none"
              aria-label="Search streams"
              placeholder="Search streams..."
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <SimpleSelect
            aria-label="Source type"
            value={sourceFilter}
            onValueChange={setSourceFilter}
            options={[
              { value: "all", label: "All sources" },
              { value: "rtmp", label: "RTMP" },
              { value: "whip", label: "WHIP" },
              { value: "room", label: "WebRTC" },
            ]}
            className="h-10 w-auto flex-1 rounded-lg border-border/70 bg-background sm:flex-none"
          />
          <SimpleSelect
            aria-label="Environment"
            value={environmentId}
            disabled={!environments.length}
            placeholder="No environments"
            options={environments.map((environment) => ({
              value: environment.id,
              label: environment.name,
            }))}
            className="h-10 w-auto flex-1 rounded-lg border-border/70 bg-background sm:flex-none"
            onValueChange={(value) => {
              const query = new URLSearchParams(search);
              query.set("environmentId", value);
              document.cookie = `relayrtc.environment.${projectId}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=31536000`;
              router.push(`${pathname}?${query}`);
            }}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh streams"
            className="size-10 shrink-0 rounded-lg border-border/70 bg-background shadow-none"
            disabled={pending || !environmentId}
            onClick={() => void load()}
          >
            <RefreshCw className={cn("size-4", pending && "animate-spin")} />
          </Button>
        </div>

        {(error || activityError) && (
          <p role="alert" className="border-b border-border/60 px-5 py-3 text-sm text-destructive">
            {error ?? activityError}
          </p>
        )}

        {visible.length ? (
          <ul className="divide-y divide-border/60 px-4 sm:px-5">
            {visible.map((stream) => {
              const href = streamWorkspaceHref(base, stream.id, environmentId);
              const status = activityFor(stream, activity);
              const sourceName =
                stream.source.kind === "room" ? "WebRTC" : stream.source.kind.toUpperCase();
              const SourceIcon = stream.source.kind === "room" ? Video : Radio;
              const isLive = status?.label === "Live";
              return (
                <li
                  key={stream.id}
                  className="group grid grid-cols-[5.5rem_minmax(0,1fr)_2rem] items-center gap-x-3 gap-y-3 py-4 sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(8rem,0.65fr)_2rem] sm:gap-x-5 sm:py-5"
                >
                  <Link
                    href={href}
                    aria-label={`Open ${stream.name}`}
                    className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-slate-950 text-slate-400 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <div
                      className={cn(
                        "absolute inset-0 bg-linear-to-br opacity-80",
                        stream.source.kind === "room"
                          ? "from-indigo-900/70 via-slate-900 to-slate-950"
                          : stream.source.kind === "whip"
                            ? "from-cyan-900/70 via-slate-900 to-slate-950"
                            : "from-slate-700 via-slate-900 to-slate-950",
                      )}
                    />
                    <div className="absolute size-20 rounded-full border border-white/5 sm:size-28" />
                    <div className="absolute size-12 rounded-full border border-white/5 sm:size-20" />
                    <SourceIcon
                      className="relative size-5 text-slate-400 sm:size-7"
                      strokeWidth={1.3}
                    />
                    {isLive && (
                      <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-red-500 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white">
                        <span className="size-1 rounded-full bg-white" />
                        Live
                      </span>
                    )}
                    <span className="absolute bottom-1.5 right-1.5 hidden rounded bg-black/40 px-1.5 py-0.5 text-[9px] text-slate-300 sm:block">
                      {sourceName} source
                    </span>
                  </Link>
                  <div className="min-w-0">
                    <Link
                      href={href}
                      className="block truncate text-sm font-semibold transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:underline"
                      title={stream.name}
                    >
                      {stream.name}
                    </Link>
                    <div className="mt-1 flex min-w-0 items-center gap-1 text-muted-foreground">
                      <span className="truncate font-mono text-[11px]" title={stream.id}>
                        {stream.id}
                      </span>
                      <CopyButton
                        value={stream.id}
                        label={`Copy ${stream.name} ID`}
                        className="size-6 shrink-0 [&_svg]:size-3"
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          stream.source.kind === "room"
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {sourceName}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {stream.profile.audioOnly
                          ? "Audio only"
                          : `${stream.profile.width} × ${stream.profile.height}`}
                      </span>
                    </div>
                  </div>
                  <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
                        isLive
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : status?.category === "scheduled"
                            ? "bg-blue-500/5 text-foreground"
                            : "bg-muted/70 text-muted-foreground",
                      )}
                    >
                      {status?.category === "scheduled" ? (
                        <Clock3 className="size-3" />
                      ) : status?.category === "ready" ? (
                        <CircleCheck className="size-3" />
                      ) : (
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            isLive ? "bg-emerald-500" : "bg-current opacity-60",
                          )}
                        />
                      )}
                      {status?.label ?? "Unknown"}
                    </span>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {activityDetail(status)}
                    </p>
                  </div>
                  <div className="col-start-3 row-start-1 sm:col-start-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Actions for ${stream.name}`}
                        className="grid size-8 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5">
                        <DropdownMenuItem render={<Link href={href} />}>
                          <ArrowUpRight className="size-4" />
                          Open stream
                        </DropdownMenuItem>
                        {canManage && (
                          <DropdownMenuItem
                            render={
                              <Link
                                href={streamWorkspaceHref(
                                  base,
                                  stream.id,
                                  environmentId,
                                  "settings",
                                )}
                              />
                            }
                          >
                            <Settings2 className="size-4" />
                            Stream settings
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() =>
                            void navigator.clipboard.writeText(stream.id).catch(() => undefined)
                          }
                        >
                          Copy stream ID
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <span className="mb-4 grid size-12 place-items-center rounded-2xl border border-border/70 bg-background text-muted-foreground">
              <Radio className="size-5" />
            </span>
            <h2 className="text-sm font-semibold">
              {!environmentId
                ? "Create an environment first"
                : filter || sourceFilter !== "all" || statusFilter !== "all"
                  ? "No streams match your filters"
                  : "Your first stream starts here"}
            </h2>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {!environmentId
                ? "Add an environment to your project to start streaming."
                : filter || sourceFilter !== "all" || statusFilter !== "all"
                  ? "Try another search, source type or status."
                  : "Connect an encoder or a WebRTC room, then prepare your first broadcast."}
            </p>
            {environmentId && (filter || sourceFilter !== "all" || statusFilter !== "all") && (
              <Button
                variant="outline"
                className="mt-5 rounded-lg"
                onClick={() => {
                  setFilter("");
                  setSourceFilter("all");
                  setStatusFilter("all");
                }}
              >
                Clear filters
              </Button>
            )}
            {environmentId && !rows.length && !error && canManage && (
              <Button className="mt-5 rounded-lg" onClick={() => router.push(createHref)}>
                <Plus className="size-4" />
                Create stream
              </Button>
            )}
          </div>
        )}

        {cursor && (
          <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {rows.length} loaded streams. Load more to expand your results.
            </p>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => void load(cursor)}>
              Load more
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
