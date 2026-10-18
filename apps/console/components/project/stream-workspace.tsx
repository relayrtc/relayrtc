"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { ArrowLeft, RefreshCw, Settings2, Plus, Square } from "lucide-react";
import { getStreamAction } from "@/actions/streaming";
import {
  commandBroadcastAction,
  getBroadcastAction,
  listBroadcastsAction,
} from "@/actions/broadcasts";
import { SimpleSelect } from "@/components/page/simple-select";
import { CopyButton } from "@/components/page/copy-button";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { ConsoleStreamDetail } from "@/lib/streaming/contracts";
import type { ConsoleBroadcast } from "@/lib/streaming/broadcast-contracts";
import { streamWorkspaceHref } from "@/lib/stream-workspace";

type Workspace = {
  projectId: string;
  environmentId: string;
  streamId: string;
  stream: ConsoleStreamDetail;
  broadcast: ConsoleBroadcast | null;
  broadcastId: string | null;
  canManage: boolean;
  href: (section?: string, broadcastId?: string | null) => string;
};
const Context = createContext<Workspace | null>(null);
export const useStreamWorkspace = () => useContext(Context);
export function StreamWorkspace({
  initialStream,
  initialRuns,
  selectedRun,
  projectBase,
  environmentName,
  canManage,
  children,
}: {
  initialStream: ConsoleStreamDetail;
  initialRuns: ConsoleBroadcast[];
  selectedRun: ConsoleBroadcast | null;
  projectBase: string;
  environmentName: string;
  canManage: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const [stream, setStream] = useState(initialStream),
    [runs, setRuns] = useState(initialRuns),
    [run, setRun] = useState(selectedRun);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const projectId = stream.projectId,
    environmentId = stream.environmentId,
    streamId = stream.id;
  const explicitRun = search.get("broadcastId");
  const overview = pathname.endsWith(`/streams/${streamId}`) || pathname.endsWith("/overview");
  const [previousInitial, setPreviousInitial] = useState(initialStream);
  if (previousInitial !== initialStream) {
    setPreviousInitial(initialStream);
    setStream(initialStream);
    setRuns(initialRuns);
    setRun(selectedRun);
  }
  useEffect(() => {
    document.cookie = `relayrtc.environment.${projectId}=${encodeURIComponent(environmentId)}; Path=/; SameSite=Lax; Max-Age=31536000`;
  }, [projectId, environmentId]);
  useEffect(() => {
    let alive = true,
      busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const [detail, listed, current, chosen] = await Promise.all([
          getStreamAction({ projectId, environmentId, streamId }),
          listBroadcastsAction({ projectId, environmentId, streamId }),
          listBroadcastsAction({ projectId, environmentId, streamId, activeOnly: true }),
          explicitRun
            ? getBroadcastAction({ projectId, environmentId, broadcastId: explicitRun })
            : Promise.resolve(null),
        ]);
        if (!alive) return;
        if (detail.error || listed.error || current.error || chosen?.error) {
          setError(
            detail.error?.description ??
              listed.error?.description ??
              current.error?.description ??
              chosen?.error?.description ??
              "Status is unavailable.",
          );
          return;
        }
        if (detail.data) setStream(detail.data);
        if (listed.data) {
          setRuns([
            ...new Map(
              [...(current.data?.data ?? []), ...listed.data.data].map((r) => [r.id, r]),
            ).values(),
          ]);
          const next = explicitRun ? chosen?.data : (current.data?.data[0] ?? listed.data.data[0]);
          setRun(next && next.streamId === streamId ? next : null);
        }
        setError(null);
      } catch {
        if (alive) setError("Live status is unavailable. Refresh to reconnect.");
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId, environmentId, streamId, explicitRun]);
  const href = (section = "overview", broadcastId: string | null | undefined = explicitRun) =>
    streamWorkspaceHref(projectBase, streamId, environmentId, section, broadcastId);
  const options = [
    { value: "automatic", label: "Current broadcast (automatic)" },
    ...[...new Map([...(run ? [run] : []), ...runs].map((r) => [r.id, r])).values()].map((r) => ({
      value: r.id,
      label: `${r.name} · ${r.state.replaceAll("_", " ")}`,
    })),
  ];
  return (
    <Context.Provider
      value={{
        projectId,
        environmentId,
        streamId,
        stream,
        broadcast: run,
        broadcastId: run?.id ?? null,
        canManage,
        href,
      }}
    >
      <div className="flex min-w-0 flex-col gap-6">
        {!pathname.endsWith("/new") && (
          <header className="space-y-4">
            <Link
              href={`${projectBase}/streams?environmentId=${encodeURIComponent(environmentId)}`}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              All streams
            </Link>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1
                    className={cn(
                      "break-words font-semibold tracking-tight",
                      overview ? "text-2xl sm:text-3xl" : "text-lg",
                    )}
                  >
                    {stream.name}
                  </h1>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium capitalize",
                      run?.state === "live"
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    <span className="size-1.5 rounded-full bg-current" />
                    {run?.state.replaceAll("_", " ") ?? "No broadcast"}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="truncate font-mono" title={stream.id}>
                    {stream.id}
                  </span>
                  <CopyButton
                    value={stream.id}
                    label="Copy stream ID"
                    className="size-6 shrink-0 [&_svg]:size-3"
                  />
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Link
                  href={href("settings")}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "rounded-lg bg-card/30",
                  )}
                >
                  <Settings2 className="size-3.5" />
                  Settings
                </Link>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="rounded-lg bg-card/30"
                  aria-label="Refresh stream"
                  disabled={refreshing}
                  onClick={() => {
                    startRefresh(() => router.refresh());
                  }}
                >
                  <RefreshCw className={refreshing ? "animate-spin" : ""} />
                </Button>
                {overview && canManage && stream.status === "active" && (
                  <BroadcastControl
                    projectId={projectId}
                    environmentId={environmentId}
                    broadcast={run}
                    createHref={href("broadcasts/new")}
                    onStopped={(id) =>
                      setRun((previous) =>
                        previous?.id === id
                          ? { ...previous, state: "stopping", desiredState: "stopped" }
                          : previous,
                      )
                    }
                  />
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 pb-4">
              <span className="text-[11px] text-muted-foreground">{environmentName}</span>
              <span aria-hidden="true" className="hidden h-3 border-l sm:block" />
              <span className="text-xs text-muted-foreground">Broadcast</span>
              <SimpleSelect
                aria-label="Selected broadcast"
                size="sm"
                className="min-w-0 max-w-full rounded-lg text-xs sm:max-w-xs [&_[data-slot=select-value]]:truncate"
                value={explicitRun ?? "automatic"}
                options={options}
                onValueChange={(value) => {
                  const query = new URLSearchParams(search);
                  if (value === "automatic") query.delete("broadcastId");
                  else query.set("broadcastId", value);
                  router.push(`${pathname}?${query}`);
                }}
              />
              <Link
                className="text-xs text-muted-foreground transition-colors hover:text-foreground sm:ml-auto"
                href={href("broadcasts")}
              >
                View broadcast history
              </Link>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </header>
        )}
        <div
          key={
            pathname.endsWith(`/streams/${streamId}`) || pathname.endsWith("/overview")
              ? "overview"
              : (run?.id ?? "no-run")
          }
        >
          {children}
        </div>
      </div>
    </Context.Provider>
  );
}

function BroadcastControl({
  projectId,
  environmentId,
  broadcast,
  createHref,
  onStopped,
}: {
  projectId: string;
  environmentId: string;
  broadcast: ConsoleBroadcast | null;
  createHref: string;
  onStopped: (id: string) => void;
}) {
  const [confirmation, setConfirmation] = useState<ConsoleBroadcast | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ identity: string; key: string } | null>(null);
  const stopping = broadcast?.state === "stopping";
  const canStop = !!broadcast && !["created", "stopped", "failed"].includes(broadcast.state);
  async function stop() {
    if (!confirmation || pending) return;
    setPending(true);
    setError(null);
    const identity = `${confirmation.id}:${confirmation.version}`;
    if (request.current?.identity !== identity)
      request.current = { identity, key: crypto.randomUUID() };
    try {
      const result = await commandBroadcastAction({
        projectId,
        environmentId,
        broadcastId: confirmation.id,
        command: "stop",
        version: confirmation.version,
        idempotencyKey: request.current.key,
      });
      if (result.error) setError(result.error.description);
      else if (result.data.status === "failed")
        setError("The broadcast could not be stopped. Refresh its status and try again.");
      else {
        request.current = null;
        onStopped(confirmation.id);
        setConfirmation(null);
      }
    } catch {
      setError("The stop request could not be confirmed. Try again to check its result.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      {canStop ? (
        <Button
          variant="destructive-solid"
          size="sm"
          className="rounded-lg"
          disabled={stopping || pending}
          onClick={() => {
            setError(null);
            setConfirmation(broadcast);
          }}
        >
          <Square className="size-3" />
          {stopping ? "Stopping..." : "Stop broadcast"}
        </Button>
      ) : (
        <Link href={createHref} className={cn(buttonVariants({ size: "sm" }), "rounded-lg")}>
          <Plus className="size-3.5" />
          Create broadcast
        </Link>
      )}
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this broadcast?</AlertDialogTitle>
            <AlertDialogDescription>
              This ends {confirmation?.name ?? "the broadcast"} and disconnects its destinations.
              Your source stays connected. Create a new broadcast for your next session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button variant="destructive-solid" disabled={pending} onClick={() => void stop()}>
              {pending ? "Stopping..." : "Stop broadcast"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
