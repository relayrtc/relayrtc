"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { getStreamAction } from "@/actions/streaming";
import { getBroadcastAction, listBroadcastsAction } from "@/actions/broadcasts";
import { SimpleSelect } from "@/components/page/simple-select";
import { CopyButton } from "@/components/page/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      <div className="space-y-6">
        <header className="space-y-4 border-b pb-5">
          <Link
            href={`${projectBase}/streams?environmentId=${encodeURIComponent(environmentId)}`}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            All streams
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="break-words text-2xl font-semibold tracking-tight">{stream.name}</h1>
                <Badge variant="outline">{environmentName}</Badge>
                <Badge variant="outline">{run?.state.replaceAll("_", " ") ?? "No broadcast"}</Badge>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="break-all">{stream.id}</span>
                <CopyButton value={stream.id} />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => {
                startRefresh(() => router.refresh());
              }}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">Broadcast</span>
            <SimpleSelect
              aria-label="Selected broadcast"
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
              className="text-sm text-muted-foreground underline underline-offset-4"
              href={href("broadcasts")}
            >
              Manage broadcasts
            </Link>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </header>
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
