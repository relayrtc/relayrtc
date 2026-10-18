"use client";
import { StreamTable } from "./stream-table";
import { StreamingTaskPage, useStreamingTask } from "./streaming-task-page";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Plus, RefreshCw, Search, MoreHorizontal, Radio } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  commandRestreamSourceAction,
  deleteRestreamSourceAction,
  getRestreamSourceAction,
  listRestreamSourcesAction,
  saveRestreamSourceAction,
} from "@/actions/restream";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { StreamPreview } from "./stream-preview";
import type { ConsoleEnvironment } from "@/lib/console-types";
import type { ConsoleStream } from "@/lib/streaming/contracts";
import type {
  ConsoleRestreamDetail,
  ConsoleRestreamSource,
} from "@/lib/streaming/restream-contracts";
export function RestreamSourcesManager({
  projectId,
  environmentId,
  environments,
  canManage,
  initialRows,
  initialError,
  streams,
}: {
  projectId: string;
  environmentId: string;
  environments: readonly ConsoleEnvironment[];
  canManage: boolean;
  initialRows: ConsoleRestreamSource[];
  initialError: string | null;
  streams: ConsoleStream[];
}) {
  const task = useStreamingTask();
  const [query, setQuery] = useState("");
  const router = useRouter(),
    pathname = usePathname();
  const [rows, setRows] = useState(initialRows),
    [error, setError] = useState(initialError),
    [pending, setPending] = useState(false),
    [detail, setDetail] = useState<ConsoleRestreamDetail | null>(null),
    [editor, setEditor] = useState<{ source: ConsoleRestreamSource | null } | null>(null),
    [deleting, setDeleting] = useState<ConsoleRestreamSource | null>(null);
  const mounted = useRef(true),
    commandKeys = useRef(new Map<string, string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const result = await listRestreamSourcesAction({ projectId, environmentId });
      if (!mounted.current) return;
      if (result.error) setError(result.error.description);
      else setRows(result.data.data);
    } catch {
      if (mounted.current) setError("Source status is unavailable.");
    }
  }, [projectId, environmentId]);
  const selectedId = detail?.id;
  useEffect(() => {
    if (!environmentId) return;
    let active = true,
      busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        const result = await listRestreamSourcesAction({ projectId, environmentId });
        if (!active) return;
        if (result.error) setError(result.error.description);
        else setRows(result.data.data);
        if (selectedId) {
          const selected = await getRestreamSourceAction({
            projectId,
            environmentId,
            sourceId: selectedId,
          });
          if (active && selected.data) setDetail(selected.data);
        }
      })()
        .catch(() => {
          if (active) setError("Source status is unavailable.");
        })
        .finally(() => {
          busy = false;
        });
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, environmentId, selectedId]);
  const keyFor = (key: string) => {
    const value = commandKeys.current.get(key) ?? crypto.randomUUID();
    commandKeys.current.set(key, value);
    return value;
  };
  const command = async (source: ConsoleRestreamSource, action: "probe" | "start" | "stop") => {
    if (pending) return;
    setPending(true);
    const commandId = `${source.id}:${action}`;
    try {
      const result = await commandRestreamSourceAction({
        projectId,
        environmentId,
        sourceId: source.id,
        command: action,
        idempotencyKey: keyFor(commandId),
      });
      if (!mounted.current) return;
      if (result.error) setError(result.error.description);
      else {
        commandKeys.current.delete(commandId);
        setDetail(result.data);
        setError(null);
        await refresh();
      }
    } catch {
      if (mounted.current)
        setError("Source command could not be confirmed. Retry the same command.");
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const visibleRows = rows.filter((source) =>
    `${source.name} ${source.protocol} ${source.host ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  if (task.active || editor)
    return (
      <StreamingTaskPage
        title={editor?.source ? "Edit source" : "Add a source"}
        description="Connect an external feed or encoder to a stream."
        guidance="Choose HLS to pull an existing playlist, or RTMP or WHIP to receive video from an encoder. Create a compatible stream in this environment before adding the source."
        backHref={task.backHref}
        onBack={task.active ? undefined : () => setEditor(null)}
      >
        {!canManage ? (
          <p>Management access is required.</p>
        ) : (
          <SourceEditor
            source={editor?.source ?? null}
            streams={streams}
            projectId={projectId}
            environmentId={environmentId}
            onSaved={() => {
              if (task.active) task.setOpen(false);
              else {
                setEditor(null);
                void refresh();
              }
            }}
          />
        )}
      </StreamingTaskPage>
    );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Source library"
        description="Manage external feeds and encoders connected to your streams."
        actions={
          <>
            {canManage && (
              <Button size="lg" disabled={!environmentId} onClick={() => task.setOpen(true)}>
                <Plus />
                Add source
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search sources"
            placeholder="Search sources"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-11 rounded-xl bg-card pl-10"
          />
        </div>
        <SimpleSelect
          aria-label="Environment"
          className="h-11 rounded-xl bg-card sm:ml-auto sm:min-w-44"
          value={environmentId}
          onValueChange={(value) => {
            document.cookie = `relayrtc.environment.${projectId}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=31536000`;
            router.push(`${pathname}?environmentId=${encodeURIComponent(value)}`);
          }}
          options={environments.map((e) => ({ value: e.id, label: e.name }))}
        />
        <Button
          className="h-11"
          variant="outline"
          disabled={!environmentId || pending}
          onClick={() => void refresh()}
        >
          <RefreshCw />
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <StreamTable>
        <Table className="w-full text-left text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="p-4">Source</TableHead>
              <TableHead className="p-4">Input</TableHead>
              <TableHead className="p-4">Status</TableHead>
              <TableHead className="p-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((source) => (
              <TableRow key={source.id} className="border-t">
                <TableCell className="p-4">
                  <Button
                    variant="link"
                    className="h-auto justify-start gap-2 p-0 font-medium text-foreground"
                    onClick={() => {
                      void getRestreamSourceAction({
                        projectId,
                        environmentId,
                        sourceId: source.id,
                      })
                        .then((result) => {
                          if (!mounted.current) return;
                          if (result.error) setError(result.error.description);
                          else setDetail(result.data);
                        })
                        .catch(() => {
                          if (mounted.current) setError("Source details are unavailable.");
                        });
                    }}
                  >
                    <Radio className="size-4 text-muted-foreground" />
                    {source.name}
                  </Button>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {streams.find((stream) => stream.id === source.streamId)?.name ??
                      source.streamId}
                  </p>
                </TableCell>
                <TableCell className="p-4">
                  {source.protocol === "hls_pull"
                    ? "HLS pull"
                    : source.protocol === "rtmp_push"
                      ? "RTMP encoder"
                      : "WHIP encoder"}
                  <p className="text-xs text-muted-foreground">
                    {source.host ?? "External encoder"} ·{" "}
                    {source.secretConfigured ? "Credentials masked" : "Stream credentials"}
                  </p>
                </TableCell>
                <TableCell className="p-4">
                  <Badge variant="secondary" className="capitalize">
                    {source.state.replaceAll("_", " ")}
                  </Badge>
                  {source.lastError && (
                    <p className="text-xs text-destructive">{source.lastError}</p>
                  )}
                </TableCell>
                <TableCell className="p-4 text-right">
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        disabled={pending}
                        aria-label={`Actions for ${source.name}`}
                        className="inline-grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5">
                        <DropdownMenuItem onClick={() => setEditor({ source })}>
                          Edit source
                        </DropdownMenuItem>
                        {(["probe", "start", "stop"] as const).map((action) => (
                          <DropdownMenuItem
                            key={action}
                            disabled={pending}
                            onClick={() => void command(source, action)}
                          >
                            {action === "probe"
                              ? "Check connection"
                              : action === "start"
                                ? "Start source"
                                : "Stop source"}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          disabled={pending}
                          onClick={() => setDeleting(source)}
                        >
                          Delete source
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!visibleRows.length && (
              <TableRow>
                <TableCell className="p-8 text-muted-foreground" colSpan={4}>
                  <p className="font-medium text-foreground">
                    {query ? "No sources match your search" : "No sources yet"}
                  </p>
                  <p className="mt-2">
                    {query
                      ? "Try a different name, protocol or host."
                      : "Add an external feed or encoder to connect it to a stream."}
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </StreamTable>
      <Sheet
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{detail?.name}</SheetTitle>
            <SheetDescription>Connection health and source usage.</SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="space-y-5 px-5 pb-6">
              <p className="break-all text-sm">Stream: {detail.streamId}</p>
              <p className="text-sm">
                {detail.state} · H.264/AAC · {detail.session?.attempts ?? 0} attempts
              </p>
              <p className="text-sm">
                Fetched: {detail.usage.fetchedBytes.toLocaleString()} bytes · Processing:{" "}
                {Math.floor(detail.usage.processingSeconds)} seconds
              </p>
              {detail.protocol !== "hls_pull" && (
                <p className="text-sm text-muted-foreground">
                  Issue ingest credentials from this stream’s details and connect your RTMP or WHIP
                  encoder. Starting this source monitors the publisher.
                </p>
              )}
              {detail.state === "live" && (
                <StreamPreview
                  projectId={projectId}
                  environmentId={environmentId}
                  streamId={detail.streamId}
                />
              )}
              <ol className="space-y-2 text-sm">
                {detail.health.map((sample, index) => (
                  <li key={index}>
                    {new Date(sample.occurredAt).toLocaleString()} · {sample.state}
                    {sample.reason ? ` · ${sample.reason}` : ""}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the source and dependent broadcasts, removes stored credentials, and keeps
              historical usage.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                if (!deleting) return;
                const sourceId = deleting.id,
                  commandId = `${sourceId}:delete`;
                setPending(true);
                void deleteRestreamSourceAction({
                  projectId,
                  environmentId,
                  sourceId,
                  idempotencyKey: keyFor(commandId),
                })
                  .then((result) => {
                    if (!mounted.current) return;
                    if (result.error) setError(result.error.description);
                    else {
                      commandKeys.current.delete(commandId);
                      setDeleting(null);
                      if (selectedId === sourceId) setDetail(null);
                      void refresh();
                    }
                  })
                  .catch(() => setError("Deletion could not be confirmed. Retry."))
                  .finally(() => setPending(false));
              }}
            >
              Delete source
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
function SourceEditor({
  source,
  streams,
  projectId,
  environmentId,
  onSaved,
}: {
  source: ConsoleRestreamSource | null;
  streams: ConsoleStream[];
  projectId: string;
  environmentId: string;
  onSaved: () => void;
}) {
  const [protocol, setProtocol] = useState(source?.protocol ?? "hls_pull"),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    key = useRef<{ payload: string; key: string } | null>(null);
  return (
    <form
      className="space-y-4 [&>label:not(:first-child)]:mt-6"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget),
          endpoint = String(form.get("endpoint") ?? ""),
          authorization = String(form.get("authorization") ?? "");
        const configuration = {
          name: String(form.get("name")),
          redistributionAuthorized: true,
          ...(source
            ? { version: source.version }
            : { streamId: String(form.get("streamId")), protocol }),
          ...(protocol === "hls_pull"
            ? {
                ...(!source || endpoint ? { endpoint } : {}),
                ...(!source || authorization || form.get("clearAuthorization") === "on"
                  ? { authorization }
                  : {}),
              }
            : {}),
          reconnectBudget: Number(form.get("reconnectBudget")),
          maxDurationSeconds: Number(form.get("maxDurationSeconds")),
          maxBytes: Number(form.get("maxBytes")),
        };
        const payload = JSON.stringify(configuration);
        if (key.current?.payload !== payload) key.current = { payload, key: crypto.randomUUID() };
        setPending(true);
        void saveRestreamSourceAction({
          projectId,
          environmentId,
          configuration,
          ...(source ? { sourceId: source.id } : {}),
          idempotencyKey: key.current.key,
        })
          .then((result) => {
            if (result.error) setError(result.error.description);
            else onSaved();
          })
          .catch(() => setError("Save could not be confirmed. Retry."))
          .finally(() => setPending(false));
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="source-name">Name</Label>
        <Input id="source-name" name="name" required maxLength={120} defaultValue={source?.name} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="external-protocol">Input</Label>
        <SimpleSelect
          className="w-full sm:w-full"
          id="external-protocol"
          value={protocol}
          onValueChange={(value) => {
            if (!source) setProtocol(value as typeof protocol);
          }}
          options={[
            { value: "hls_pull", label: "HLS pull (HTTP/HTTPS)" },
            { value: "rtmp_push", label: "RTMP encoder" },
            { value: "whip_push", label: "WHIP encoder" },
          ]}
        />
      </div>
      <p className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
        {protocol === "hls_pull"
          ? "Use a public HLS playlist with media hosts allowed by your operator. Connect it to an RTMP stream with no active publisher. Private network addresses are not supported."
          : "Save the source, then generate credentials on the stream's Overview page. Start monitoring and connect your encoder. Use the live preview to confirm media is arriving."}
      </p>
      {!source && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="external-stream">Stream</Label>
            <SimpleSelect
              key={protocol}
              id="external-stream"
              name="streamId"
              required
              placeholder="Choose a compatible stream"
              className="w-full sm:w-full"
              options={streams
                .filter(
                  (s) =>
                    s.status === "active" &&
                    s.source.kind === (protocol === "whip_push" ? "whip" : "rtmp"),
                )
                .map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            HLS and RTMP sources need an RTMP stream. WHIP sources need a WHIP stream.
          </p>
        </>
      )}
      {protocol === "hls_pull" && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="source-endpoint">HLS URL {source ? "(leave blank to keep)" : ""}</Label>
            <Input
              id="source-endpoint"
              type="password"
              name="endpoint"
              autoComplete="off"
              required={!source}
              maxLength={2048}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="source-authorization">
              Authorization header {source ? "(leave blank to keep)" : ""}
            </Label>
            <Input
              id="source-authorization"
              name="authorization"
              type="password"
              autoComplete="off"
              maxLength={2048}
            />
          </div>
          {source && (
            <Label className="flex items-center gap-2 text-sm leading-relaxed">
              <Checkbox value="on" name="clearAuthorization" />
              Remove authorization header
            </Label>
          )}
          <p className="text-xs text-muted-foreground">
            All playlist and segment hosts must be allowed by your operator. URLs and authorization
            stay encrypted.
          </p>
        </>
      )}
      <div className="grid gap-2">
        <Label htmlFor="source-retries">Reconnect attempts</Label>
        <Input
          id="source-retries"
          name="reconnectBudget"
          type="number"
          required
          min={0}
          max={5}
          defaultValue={source?.reconnectBudget ?? 3}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="source-duration">Maximum duration (seconds)</Label>
        <Input
          id="source-duration"
          name="maxDurationSeconds"
          type="number"
          required
          min={60}
          max={86400}
          defaultValue={source?.maxDurationSeconds ?? 14400}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="source-bytes">Download limit (bytes)</Label>
        <Input
          id="source-bytes"
          name="maxBytes"
          type="number"
          required
          min={1048576}
          max={20000000000}
          defaultValue={source?.maxBytes ?? 2000000000}
        />
      </div>
      <Label className="flex items-center gap-2 text-sm leading-relaxed">
        <Checkbox required />I have permission to redistribute this source.
      </Label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={pending} type="submit">
        {pending ? "Saving…" : "Save source"}
      </Button>
    </form>
  );
}
