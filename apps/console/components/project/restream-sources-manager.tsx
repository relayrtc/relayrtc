"use client";
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
import { Plus, RefreshCw } from "lucide-react";
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
  return (
    <div className="space-y-6">
      <PageHeader
        title="Source library"
        description="Optional external inputs: bring an HLS feed or a registered RTMP/WHIP source into a stream. Connect your own OBS or Streamlabs encoder from the stream Overview page."
        actions={
          <>
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
            {canManage && (
              <Button disabled={!environmentId} onClick={() => setEditor({ source: null })}>
                <Plus className="mr-2 size-4" />
                Add source
              </Button>
            )}
          </>
        }
      />
      <SimpleSelect
        value={environmentId}
        onValueChange={(value) =>
          router.push(`${pathname}?environmentId=${encodeURIComponent(value)}`)
        }
        options={environments.map((e) => ({ value: e.id, label: e.name }))}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table className="w-full text-left text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="p-4">Source</TableHead>
              <TableHead className="p-4">Input</TableHead>
              <TableHead className="p-4">State</TableHead>
              <TableHead className="p-4">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((source) => (
              <TableRow key={source.id} className="border-t">
                <TableCell className="p-4">
                  <Button
                    variant="link"
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
                    {source.name}
                  </Button>
                  <p className="text-xs text-muted-foreground">{source.streamId}</p>
                </TableCell>
                <TableCell className="p-4">
                  {source.protocol}
                  <p className="text-xs text-muted-foreground">
                    {source.host ?? "External encoder"} ·{" "}
                    {source.secretConfigured ? "Credentials masked" : "Stream credentials"}
                  </p>
                </TableCell>
                <TableCell className="p-4">
                  <Badge variant="outline">{source.state}</Badge>
                  {source.lastError && (
                    <p className="text-xs text-destructive">{source.lastError}</p>
                  )}
                </TableCell>
                <TableCell className="p-4">
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setEditor({ source })}
                      >
                        Edit
                      </Button>
                      {(["probe", "start", "stop"] as const).map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => void command(source, action)}
                        >
                          {action[0]!.toUpperCase() + action.slice(1)}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setDeleting(source)}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell className="p-8 text-muted-foreground" colSpan={4}>
                  No external sources registered.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Sheet
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{detail?.name}</SheetTitle>
            <SheetDescription>Source health and observed usage</SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="space-y-4 p-4">
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
      <Sheet
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editor?.source ? "Edit source" : "Add source"}</SheetTitle>
            <SheetDescription>
              Only use sources you are authorized to redistribute.
            </SheetDescription>
          </SheetHeader>
          {editor && (
            <SourceEditor
              key={editor.source?.id ?? "new"}
              source={editor.source}
              streams={streams}
              projectId={projectId}
              environmentId={environmentId}
              onSaved={() => {
                setEditor(null);
                void refresh();
              }}
            />
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
      className="space-y-4 p-4"
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
      <Label htmlFor="source-name">Name</Label>
      <Input id="source-name" name="name" required maxLength={120} defaultValue={source?.name} />
      <Label htmlFor="external-protocol">Input</Label>
      <SimpleSelect
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
      {!source && (
        <>
          <Label htmlFor="external-stream">Stream</Label>
          <SimpleSelect
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
          <p className="text-xs text-muted-foreground">
            Create an RTMP stream first for an HLS pull or RTMP encoder source.
          </p>
        </>
      )}
      {protocol === "hls_pull" && (
        <>
          <Label htmlFor="source-endpoint">HLS URL {source ? "(leave blank to keep)" : ""}</Label>
          <Input
            id="source-endpoint"
            type="password"
            name="endpoint"
            autoComplete="off"
            required={!source}
            maxLength={2048}
          />
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
      <Label htmlFor="source-retries">Reconnect retries</Label>
      <Input
        id="source-retries"
        name="reconnectBudget"
        type="number"
        required
        min={0}
        max={5}
        defaultValue={source?.reconnectBudget ?? 3}
      />
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
      <Label htmlFor="source-bytes">Maximum fetched bytes</Label>
      <Input
        id="source-bytes"
        name="maxBytes"
        type="number"
        required
        min={1048576}
        max={20000000000}
        defaultValue={source?.maxBytes ?? 2000000000}
      />
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
