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
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import type { RecordingPolicy } from "@relayrtc/types";
import {
  listRecordingsAction,
  getRecordingAction,
  startRecordingAction,
  commandRecordingAction,
  getRecordingPolicyAction,
  setRecordingPolicyAction,
  createAssetGrantAction,
} from "@/actions/recordings";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import type { ConsoleRecording } from "@/lib/streaming/recording-contracts";
import { RecordingPreview } from "./recording-preview";

const defaultPolicy: RecordingPolicy = {
  mode: "manual",
  maxDurationSeconds: 14400,
  retentionSeconds: 604800,
  region: "us-east-1",
  allowPartial: false,
  exportMp4: true,
  segmentEvents: false,
  consentAcknowledged: true,
};
export function RecordingsManager({
  projectId,
  environmentId,
  environments,
  canManage,
  initialRows,
  initialCursor,
  initialError,
}: {
  projectId: string;
  environmentId: string;
  environments: readonly ConsoleEnvironment[];
  canManage: boolean;
  initialRows: ConsoleRecording[];
  initialCursor: string | null;
  initialError: string | null;
}) {
  const workspace = useStreamWorkspace();
  const scopedStreamId = workspace?.streamId;
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const [rows, setRows] = useState(initialRows),
    [cursor, setCursor] = useState(initialCursor),
    [error, setError] = useState(initialError),
    [pending, setPending] = useState(false),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<ConsoleRecording | null>(null),
    [confirmDelete, setConfirmDelete] = useState(false),
    [download, setDownload] = useState<string | null>(null);
  const [streamId, setStreamId] = useState(workspace?.streamId ?? ""),
    [broadcastId, setBroadcastId] = useState(workspace?.broadcastId ?? ""),
    [policy, setPolicy] = useState<RecordingPolicy>(defaultPolicy),
    [version, setVersion] = useState(0),
    [consent, setConsent] = useState(false);
  const sequence = useRef(0),
    mounted = useRef(true),
    keys = useRef(new Map<string, string>());
  const key = (identity: string) => {
    const value = keys.current.get(identity) ?? crypto.randomUUID();
    keys.current.set(identity, value);
    return value;
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(
    async (next?: string) => {
      const revision = ++sequence.current;
      const result = await listRecordingsAction({
        projectId,
        environmentId,
        ...(scopedStreamId ? { streamId: scopedStreamId } : {}),
        ...(next ? { cursor: next } : {}),
      });
      if (!mounted.current || revision !== sequence.current) return;
      if (result.error) {
        setError(result.error.description);
        return;
      }
      setRows((previous) => {
        const map = new Map((next ? previous : []).map((row) => [row.id, row]));
        for (const row of result.data.data) map.set(row.id, row);
        return [...map.values()];
      });
      setCursor(result.data.nextCursor);
      setError(null);
    },
    [projectId, environmentId, scopedStreamId],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      if (selected) {
        void getRecordingAction({ projectId, environmentId, recordingId: selected.id }).then(
          (result) => {
            if (mounted.current && result.data)
              setSelected((previous) => (previous?.id === result.data.id ? result.data : previous));
          },
        );
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [projectId, environmentId, selected]);
  const execute = async (action: "start" | "policy" | "stop" | "delete" | "download") => {
    setPending(true);
    setError(null);
    const identity = JSON.stringify({
      action,
      streamId,
      broadcastId,
      policy,
      version,
      recordingId: selected?.id,
    });
    const idempotencyKey = key(identity);
    try {
      if (action === "start" || action === "policy") {
        if (!consent) {
          setError(
            "Confirm that participants have been informed and the required recording consent has been obtained.",
          );
          return;
        }
        const scope = { projectId, environmentId, streamId, idempotencyKey };
        const result =
          action === "start"
            ? await startRecordingAction({
                ...scope,
                configuration: { ...(broadcastId ? { broadcastId } : {}), policy },
              })
            : await setRecordingPolicyAction({ ...scope, version, policy });
        if (result.error) {
          setError(result.error.description);
          return;
        }
        keys.current.delete(identity);
        setCreating(false);
        await load();
      } else if (selected) {
        if (action === "download") {
          const result = await createAssetGrantAction({
            projectId,
            environmentId,
            assetId: selected.assetId,
            action: "download",
            idempotencyKey,
          });
          if (result.error) {
            setError(result.error.description);
            return;
          }
          setDownload(result.data.url);
        } else {
          const result = await commandRecordingAction({
            projectId,
            environmentId,
            recordingId: selected.id,
            command: action,
            idempotencyKey,
          });
          if (result.error) {
            setError(result.error.description);
            return;
          }
          setSelected(result.data);
          setConfirmDelete(false);
          setDownload(null);
          await load();
        }
        keys.current.delete(identity);
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const loadPolicy = async () => {
    setPending(true);
    try {
      const result = await getRecordingPolicyAction({ projectId, environmentId, streamId });
      if (!mounted.current) return;
      if (result.error) setError(result.error.description);
      else {
        setPolicy(result.data.policy ?? defaultPolicy);
        setVersion(result.data.version);
        setConsent(false);
      }
    } catch {
      if (mounted.current) setError("Recording policy is unavailable. Try again.");
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Recordings"
        description="Save broadcast output and manage private video playback."
      />
      <div className="flex flex-wrap gap-2">
        {!workspace && (
          <SimpleSelect
            aria-label="Environment"
            value={environmentId}
            options={environments.map((e) => ({ value: e.id, label: e.name }))}
            onValueChange={(value) => {
              const params = new URLSearchParams(search.toString());
              params.set("environmentId", value);
              router.push(`${pathname}?${params}`);
            }}
          />
        )}
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
          <Button
            disabled={!environmentId}
            onClick={() => {
              setCreating(true);
              setConsent(false);
              if (workspace) void loadPolicy();
            }}
          >
            <Plus />
            Recording settings
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border">
        <Table className="w-full text-left text-sm">
          <TableHeader>
            <TableRow className="border-b">
              <TableHead className="p-4">Recording</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Storage</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="border-b last:border-0">
                <TableCell className="p-4">
                  <p className="font-medium">{new Date(row.createdAt).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">{row.streamId}</p>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{row.state}</Badge>
                  {row.partial && <Badge variant="secondary">Partial</Badge>}
                </TableCell>
                <TableCell>{Math.round(row.durationSeconds)} seconds</TableCell>
                <TableCell>{(row.storedBytes / 1048576).toFixed(1)} MB</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelected(row);
                      setDownload(null);
                    }}
                  >
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!rows.length && (
          <p className="p-4 text-sm text-muted-foreground">
            No recordings in this environment. Start a broadcast, then request a recording.
          </p>
        )}
      </div>
      {cursor && (
        <Button
          variant="outline"
          onClick={() => {
            void load(cursor);
          }}
        >
          Load more
        </Button>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Recording settings</DialogTitle>
            <DialogDescription>
              Record the shared broadcast output. Automatic policy changes apply to newly created
              broadcasts.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!workspace && (
            <>
              <Label htmlFor="recording-stream">Stream ID</Label>
              <Input
                id="recording-stream"
                value={streamId}
                onChange={(e) => {
                  setStreamId(e.target.value);
                  setVersion(0);
                  setConsent(false);
                }}
                placeholder="Copy the ID from Streams"
              />
              <Button
                variant="outline"
                disabled={pending || !streamId}
                onClick={() => {
                  void loadPolicy();
                }}
              >
                Load saved policy
              </Button>
              <Label htmlFor="recording-broadcast">Broadcast ID for manual recording</Label>
              <Input
                id="recording-broadcast"
                value={broadcastId}
                onChange={(e) => setBroadcastId(e.target.value)}
                placeholder="Optional when exactly one broadcast is running"
              />
            </>
          )}
          <Label>Start policy</Label>
          <SimpleSelect
            value={policy.mode}
            options={[
              { value: "manual", label: "Manual" },
              { value: "automatic", label: "Automatic on broadcast start" },
            ]}
            onValueChange={(value) =>
              setPolicy({ ...policy, mode: value === "automatic" ? "automatic" : "manual" })
            }
          />
          <Label htmlFor="recording-duration">Maximum duration (seconds)</Label>
          <Input
            id="recording-duration"
            type="number"
            min={10}
            max={86400}
            value={policy.maxDurationSeconds}
            onChange={(e) => setPolicy({ ...policy, maxDurationSeconds: Number(e.target.value) })}
          />
          <Label htmlFor="recording-retention">Keep recording (days)</Label>
          <Input
            id="recording-retention"
            type="number"
            min={1}
            max={90}
            value={policy.retentionSeconds / 86400}
            onChange={(e) =>
              setPolicy({ ...policy, retentionSeconds: Number(e.target.value) * 86400 })
            }
          />
          <Label htmlFor="recording-region">Storage region</Label>
          <Input
            id="recording-region"
            value={policy.region}
            onChange={(e) => setPolicy({ ...policy, region: e.target.value })}
          />
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={policy.exportMp4}
              onCheckedChange={(e) => setPolicy({ ...policy, exportMp4: e })}
            />
            Create MP4 download
          </Label>
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={policy.allowPartial}
              onCheckedChange={(e) => setPolicy({ ...policy, allowPartial: e })}
            />
            Allow playable partial recordings after interruptions
          </Label>
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={policy.segmentEvents}
              onCheckedChange={(e) => setPolicy({ ...policy, segmentEvents: e })}
            />
            Send a webhook for each saved segment
          </Label>
          <Label className="flex items-start gap-2 text-sm">
            <Checkbox checked={consent} onCheckedChange={(e) => setConsent(e)} />
            Participants have been informed and the required recording consent has been obtained.
          </Label>
          <div className="flex gap-2">
            <Button
              disabled={pending || !consent || !streamId}
              variant="outline"
              onClick={() => {
                void execute("policy");
              }}
            >
              Save policy
            </Button>
            <Button
              disabled={pending || !consent || !streamId}
              onClick={() => {
                void execute("start");
              }}
            >
              Start recording now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setDownload(null);
          }
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Recording details</SheetTitle>
            <SheetDescription>{selected?.id}</SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="space-y-4 px-4 pb-6">
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Badge variant="outline">
                {selected.state === "recording" ? "● Recording" : selected.state}
              </Badge>
              {selected.partial && (
                <p className="text-sm">
                  This is a partial recording. Missing media is marked by playback discontinuities.
                </p>
              )}
              {selected.lastError && (
                <p role="status" className="text-sm text-destructive">
                  {selected.lastError.replaceAll("_", " ").toLowerCase()}
                </p>
              )}
              {selected.state === "ready" && (
                <RecordingPreview
                  projectId={projectId}
                  environmentId={environmentId}
                  recordingId={selected.id}
                  assetId={selected.assetId}
                />
              )}
              {["queued", "recording", "finalizing"].includes(selected.state) && (
                <p className="text-sm text-muted-foreground">
                  {selected.state === "finalizing"
                    ? "Preparing playback, metadata and requested downloads."
                    : "Capture stops when the broadcast ends or its duration limit is reached."}
                </p>
              )}
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt>Broadcast</dt>
                <dd className="break-all">{selected.broadcastId}</dd>
                <dt>Asset</dt>
                <dd className="break-all">{selected.assetId}</dd>
                <dt>Recorded media</dt>
                <dd>{selected.durationSeconds.toFixed(1)} seconds</dd>
                <dt>Processing</dt>
                <dd>{selected.processingSeconds.toFixed(1)} seconds</dd>
                <dt>Storage</dt>
                <dd>{(selected.storedBytes / 1048576).toFixed(1)} MB</dd>
                <dt>Storage usage</dt>
                <dd>{selected.storageByteSeconds.toFixed(0)} byte-seconds</dd>
                <dt>Saved segments</dt>
                <dd>{selected.segmentCount}</dd>
                <dt>Expires</dt>
                <dd>
                  {selected.expiresAt
                    ? new Date(selected.expiresAt).toLocaleString()
                    : "After finalization"}
                </dd>
              </dl>
              {selected.state === "ready" && selected.policy.exportMp4 && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    void execute("download");
                  }}
                >
                  Prepare download
                </Button>
              )}
              {download && (
                <a href={download} className="block text-sm underline" referrerPolicy="no-referrer">
                  Download MP4 (link expires in five minutes)
                </a>
              )}
              {canManage && ["queued", "recording"].includes(selected.state) && (
                <Button
                  disabled={pending}
                  onClick={() => {
                    void execute("stop");
                  }}
                >
                  Stop and finalize
                </Button>
              )}
              {canManage && !["deleting", "deleted"].includes(selected.state) && (
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete recording
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
            <AlertDialogDescription>
              Playback and download access ends immediately. Saved media is permanently removed
              after capture stops. Usage history is retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void execute("delete");
              }}
            >
              Delete recording
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
