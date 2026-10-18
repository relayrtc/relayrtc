"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { useStreamWorkspace } from "./stream-workspace";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BroadcastClient } from "@relayrtc/client";
import { Plus, RefreshCw } from "lucide-react";
import {
  commandBroadcastAction,
  createBroadcastAction,
  getBroadcastAction,
  getBroadcastOutputsAction,
  listBroadcastsAction,
} from "@/actions/broadcasts";
import { listDestinationsAction, retryBroadcastOutputAction } from "@/actions/destinations";
import type { ConsoleDestination } from "@/lib/streaming/destination-contracts";
import { getStreamingOperationAction } from "@/actions/streaming";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ConsoleEnvironment } from "@/lib/console-types";
import type { ConsoleBroadcast, ConsoleBroadcastDetail } from "@/lib/streaming/broadcast-contracts";
import { StreamPreview } from "./stream-preview";

const states = [
  "all",
  "created",
  "waiting_for_source",
  "starting",
  "live",
  "reconnecting",
  "degraded",
  "stopping",
  "stopped",
  "failed",
];
export function BroadcastsManager({
  projectId,
  environmentId,
  environments,
  canManage,
  initialRows,
  initialCursor,
  initialError,
  initialLimits,
}: {
  projectId: string;
  environmentId: string;
  environments: readonly ConsoleEnvironment[];
  canManage: boolean;
  initialRows: ConsoleBroadcast[];
  initialCursor: string | null;
  initialError: string | null;
  initialLimits: { activeRuns: number; maxActiveRuns: number; reservedOutputs: number } | null;
}) {
  const workspace = useStreamWorkspace();
  const scopedStreamId = workspace?.streamId;
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const [rows, setRows] = useState(initialRows),
    [cursor, setCursor] = useState(initialCursor),
    [error, setError] = useState(initialError);
  const [filter, setFilter] = useState("all"),
    [pending, setPending] = useState(false),
    [creating, setCreating] = useState(false);
  const [limits, setLimits] = useState(initialLimits);
  const [selected, setSelected] = useState<ConsoleBroadcast | null>(null);
  const sequence = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(
    async (next?: string, state = filter) => {
      const current = ++sequence.current;
      setPending(true);
      try {
        const result = await listBroadcastsAction({
          projectId,
          environmentId,
          ...(scopedStreamId ? { streamId: scopedStreamId } : {}),
          ...(next ? { cursor: next } : {}),
          ...(state !== "all" ? { state } : {}),
        });
        if (!mounted.current || current !== sequence.current) return;
        if (result.error) setError(result.error.description);
        else {
          setRows((old) => (next ? [...old, ...result.data.data] : result.data.data));
          setCursor(result.data.nextCursor);
          setLimits(result.data.limits);
          setError(null);
        }
      } catch {
        if (mounted.current) setError("Broadcasts are unavailable. Try again.");
      } finally {
        if (mounted.current && current === sequence.current) setPending(false);
      }
    },
    [projectId, environmentId, filter, scopedStreamId],
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Broadcasts"
        description="A broadcast is one live run of this stream. Start a run to record, make clips or send video to platforms."
      />
      <div className="flex flex-wrap items-center gap-3">
        {!workspace && (
          <SimpleSelect
            aria-label="Environment"
            value={environmentId}
            options={environments.map((item) => ({ value: item.id, label: item.name }))}
            onValueChange={(value) => {
              const query = new URLSearchParams(search);
              query.set("environmentId", value);
              router.push(`${pathname}?${query}`);
            }}
          />
        )}
        <SimpleSelect
          aria-label="Run state"
          value={filter}
          options={states.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
          onValueChange={(value) => {
            setFilter(value);
            void load(undefined, value);
          }}
        />
        <Button
          variant="outline"
          disabled={pending || !environmentId}
          onClick={() => {
            void load();
          }}
        >
          <RefreshCw />
          Refresh
        </Button>
        {canManage && (
          <Button disabled={pending || !environmentId} onClick={() => setCreating(true)}>
            <Plus />
            Create run
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!environmentId && <p>Select an active environment to manage broadcasts.</p>}
      {limits && (
        <p className="text-sm text-muted-foreground">
          Environment run capacity: {limits.activeRuns}/{limits.maxActiveRuns}; reserved output
          slots: {limits.reservedOutputs}.
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border">
        <Table className="w-full text-left text-sm">
          <TableHeader>
            <TableRow className="border-b">
              <TableHead className="p-4">Run</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((run) => (
              <TableRow key={run.id} className="border-b last:border-0">
                <TableCell className="p-4">
                  <p className="font-medium">{run.name}</p>
                  <p className="text-xs text-muted-foreground">{run.id}</p>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{run.state.replaceAll("_", " ")}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{run.streamId}</TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      workspace ? router.push(workspace.href("overview", run.id)) : setSelected(run)
                    }
                  >
                    Open broadcast
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!rows.length && (
          <p className="p-4 text-sm text-muted-foreground">
            No broadcast runs match this selection.
          </p>
        )}
      </div>
      {cursor && (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            void load(cursor);
          }}
        >
          Load more
        </Button>
      )}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Create broadcast run</SheetTitle>
            <SheetDescription>
              Capture the current stream configuration. A stopped run cannot restart; create a new
              run instead.
            </SheetDescription>
          </SheetHeader>
          {creating && (
            <BroadcastForm
              projectId={projectId}
              environmentId={environmentId}
              onSaved={(run) => {
                setCreating(false);
                if (workspace) router.push(workspace.href("overview", run.id));
                else void load();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            void load();
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>
              Live source/output health and durable operation progress.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <BroadcastDetails
              key={selected.id}
              projectId={projectId}
              environmentId={environmentId}
              broadcastId={selected.id}
              canManage={canManage}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function BroadcastForm({
  projectId,
  environmentId,
  onSaved,
}: {
  projectId: string;
  environmentId: string;
  onSaved: (run: ConsoleBroadcast) => void;
}) {
  const workspace = useStreamWorkspace();
  const scopedStreamId = workspace?.streamId;
  const [destinationsReady, setDestinationsReady] = useState(!scopedStreamId);
  const [destinationLoadError, setDestinationLoadError] = useState<string | null>(null);
  const [destinationRetry, setDestinationRetry] = useState(0);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<ConsoleDestination[]>([]);
  const [destinationIds, setDestinationIds] = useState<string[]>([]);
  const [streamId, setStreamId] = useState(workspace?.streamId ?? "");
  const selection = useRef(0);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!scopedStreamId || !streamId) return;
    let active = true;
    void listDestinationsAction({ projectId, environmentId, streamId })
      .then((result) => {
        if (!active) return;
        if (result.error) setDestinationLoadError(result.error.description);
        else {
          const enabled = result.data.data.filter((d) => d.enabled);
          setDestinationsReady(true);
          setDestinations(enabled);
          setDestinationIds(enabled.map((d) => d.id));
        }
      })
      .catch(() => {
        if (active) setDestinationLoadError("Platform destinations are unavailable.");
      });
    return () => {
      active = false;
    };
  }, [projectId, environmentId, streamId, scopedStreamId, destinationRetry]);
  return (
    <form
      className="space-y-4 p-4"
      onChange={() => {
        key.current = crypto.randomUUID();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!destinationsReady) {
          setError("Wait for destinations, retry loading, or choose private playback only.");
          return;
        }
        setError(null);
        const form = new FormData(event.currentTarget);
        setPending(true);
        void createBroadcastAction({
          projectId,
          environmentId,
          idempotencyKey: key.current,
          configuration: {
            name: String(form.get("name")),
            streamId: String(form.get("streamId")),
            destinationIds,
            waitTimeoutSeconds: Number(form.get("waitTimeoutSeconds")),
            maxDurationSeconds: Number(form.get("maxDurationSeconds")),
          },
        })
          .then((result) => {
            if (result.error) setError(result.error.description);
            else onSaved(result.data);
          })
          .catch(() => setError("Creation failed. Retry the same configuration."))
          .finally(() => setPending(false));
      }}
    >
      <Label htmlFor="broadcast-name">Name</Label>
      <Input
        id="broadcast-name"
        name="name"
        required
        maxLength={120}
        defaultValue={workspace?.stream.name}
      />
      {workspace ? (
        <input type="hidden" name="streamId" value={streamId} />
      ) : (
        <>
          {" "}
          <Label htmlFor="broadcast-stream">Stream ID</Label>
          <Input
            id="broadcast-stream"
            name="streamId"
            required
            value={streamId}
            onChange={(event) => {
              selection.current++;
              setStreamId(event.target.value);
              setDestinations([]);
              setDestinationIds([]);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={pending || !streamId}
            onClick={() => {
              const current = ++selection.current;
              void listDestinationsAction({ projectId, environmentId, streamId })
                .then((result) => {
                  if (current !== selection.current) return;
                  if (result.error) setError(result.error.description);
                  else {
                    setDestinations(result.data.data.filter((d) => d.enabled));
                    setError(null);
                  }
                })
                .catch(() => setError("Destinations are unavailable."));
            }}
          >
            Load destinations
          </Button>
        </>
      )}
      {destinationLoadError && (
        <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm">
          <p>{destinationLoadError}</p>
          <p className="text-muted-foreground">
            Retry, or create this broadcast with private playback only. No platform outputs will be
            selected.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setDestinationLoadError(null);
                setDestinationsReady(false);
                setDestinationRetry((v) => v + 1);
              }}
            >
              Retry destinations
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setDestinations([]);
                setDestinationIds([]);
                setDestinationLoadError(null);
                setDestinationsReady(true);
              }}
            >
              Continue with private playback only
            </Button>
          </div>
        </div>
      )}
      {destinations.map((destination) => (
        <Label key={destination.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={destinationIds.includes(destination.id)}
            onCheckedChange={(event) => {
              setDestinationIds((ids) =>
                event ? [...ids, destination.id] : ids.filter((id) => id !== destination.id),
              );
              key.current = crypto.randomUUID();
            }}
          />
          {destination.name} ({destination.profile})
        </Label>
      ))}
      <p className="text-sm text-muted-foreground">
        Private playback is included. Platform destinations are optional: select them to also send
        your video to YouTube, Twitch or another RTMP service. Connect your encoder from Overview.
      </p>
      <Label htmlFor="broadcast-wait">Source wait timeout (seconds)</Label>
      <Input
        id="broadcast-wait"
        name="waitTimeoutSeconds"
        type="number"
        min={10}
        max={600}
        defaultValue={120}
        required
      />
      <Label htmlFor="broadcast-duration">Maximum run duration (seconds)</Label>
      <Input
        id="broadcast-duration"
        name="maxDurationSeconds"
        type="number"
        min={60}
        max={workspace?.stream.maxDurationSeconds ?? 86400}
        defaultValue={Math.min(14400, workspace?.stream.maxDurationSeconds ?? 14400)}
        required
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending || !destinationsReady}>
        {pending
          ? "Creating..."
          : !destinationsReady
            ? destinationLoadError
              ? "Choose how to continue"
              : "Loading destinations..."
            : "Create broadcast"}
      </Button>
    </form>
  );
}
export function BroadcastDetails({
  compact = false,
  projectId,
  environmentId,
  broadcastId,
  canManage,
}: {
  compact?: boolean;
  projectId: string;
  environmentId: string;
  broadcastId: string;
  canManage: boolean;
}) {
  const [detail, setDetail] = useState<ConsoleBroadcastDetail | null>(null),
    [confirmation, setConfirmation] = useState<"start" | "stop" | null>(null);
  const client = useMemo(() => {
    const scope = { projectId, environmentId, broadcastId };
    const command =
      (kind: "start" | "stop") =>
      async (input: { version: number; idempotencyKey: string }, signal: AbortSignal) => {
        const result = await commandBroadcastAction({ ...scope, command: kind, ...input });
        signal.throwIfAborted();
        if (result.error) throw new Error("Broadcast command unavailable");
        return result.data;
      };
    return new BroadcastClient({
      ...(canManage
        ? {
            retryOutput: async (
              outputId: string,
              input: { version: number; idempotencyKey: string },
              signal: AbortSignal,
            ) => {
              const result = await retryBroadcastOutputAction({ ...scope, outputId, ...input });
              signal.throwIfAborted();
              if (result.error) throw new Error("Output retry unavailable");
              return result.data;
            },
          }
        : {}),
      getBroadcast: async (signal) => {
        const result = await getBroadcastAction(scope);
        signal.throwIfAborted();
        if (result.error) throw new Error("Broadcast unavailable");
        setDetail(result.data);
        return result.data;
      },
      getOutputs: async (signal) => {
        const result = await getBroadcastOutputsAction(scope);
        signal.throwIfAborted();
        if (result.error) throw new Error("Outputs unavailable");
        return result.data;
      },
      getOperation: async (operationId, signal) => {
        const result = await getStreamingOperationAction({ projectId, environmentId, operationId });
        signal.throwIfAborted();
        if (result.error) throw new Error("Operation unavailable");
        return result.data;
      },
      start: command("start"),
      stop: command("stop"),
    });
  }, [projectId, environmentId, broadcastId, canManage]);
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getServerSnapshot,
  );
  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);
  const run = snapshot.broadcast;
  return (
    <div className="space-y-4">
      {snapshot.error && (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Badge variant="outline">{run?.state ?? "loading"}</Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void client.refresh(true);
          }}
        >
          Refresh status
        </Button>
        {canManage && (
          <>
            <Button
              size="sm"
              disabled={!run || run.state !== "created" || !!snapshot.pending}
              onClick={() => setConfirmation("start")}
            >
              Start run
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!run || ["stopped", "failed"].includes(run.state) || !!snapshot.pending}
              onClick={() => setConfirmation("stop")}
            >
              Stop run
            </Button>
          </>
        )}
      </div>
      {run && (
        <>
          <p className="text-sm">
            Source session: {run.sourceSessionId ?? "waiting"}; generation:{" "}
            {run.sourceGeneration ?? "pending"}
          </p>
          {run.lastError && <p role="status">{run.lastError}</p>}
        </>
      )}
      {snapshot.operation && (
        <p role="status" className="text-sm">
          Operation {snapshot.operation.id}: {snapshot.operation.status}
          {snapshot.operation.errorCode ? ` (${snapshot.operation.errorCode})` : ""}
        </p>
      )}
      {detail && (
        <>
          <p className="text-xs text-muted-foreground">
            Correlation: {detail.correlationId ?? "unavailable"}
          </p>
          <p className="text-sm">
            Observed run: {Math.round(detail.usage.runSeconds)} s; outputs:{" "}
            {Math.round(detail.usage.outputSeconds)} s; reserved slots:{" "}
            {Math.round(detail.usage.reservationSeconds)} s. Coverage: {detail.usage.coverage}.
          </p>
          {!compact && run && ["live", "degraded"].includes(run.state) && (
            <StreamPreview
              projectId={projectId}
              environmentId={environmentId}
              streamId={detail.streamId}
            />
          )}
        </>
      )}
      <div className="space-y-2">
        {snapshot.outputs.map((output) => (
          <div key={output.id} className="rounded-lg border p-3 text-sm">
            <p>
              {output.destinationName ?? output.kind.toUpperCase()}{" "}
              <Badge variant="outline">{output.state}</Badge>
            </p>
            <p>
              {output.id}; attempts: {output.attempts}
            </p>
            {output.lastError && <p role="status">{output.lastError}</p>}
            <p className="text-xs text-muted-foreground">
              {Math.round(output.outputSeconds ?? 0)} s ? {Math.round((output.bitrate ?? 0) / 1000)}{" "}
              kbit/s ? {output.bytes ?? 0} bytes ? {output.droppedFrames ?? 0} dropped frames
            </p>
            {canManage &&
              ["retry", "failed"].includes(output.state) &&
              run &&
              !["stopped", "failed", "stopping"].includes(run.state) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!snapshot.pending}
                  onClick={() => {
                    void client.retryOutput(output.id);
                  }}
                >
                  Retry output
                </Button>
              )}
          </div>
        ))}
      </div>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !snapshot.pending) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation === "start" ? "Start this run?" : "Stop this run?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "start"
                ? "Wait for the authorized source, then attach the configured output. The stream configuration is snapshotted for this run."
                : "Release output jobs and reservations. The source room and its stream remain active. This run cannot restart."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={!!snapshot.pending}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!!snapshot.pending}
              onClick={() => {
                const action = confirmation === "start" ? client.start : client.stop;
                void action().then(() => {
                  if (!client.getSnapshot().error) setConfirmation(null);
                });
              }}
            >
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
