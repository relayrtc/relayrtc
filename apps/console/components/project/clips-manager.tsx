"use client";
import { StreamSectionCard } from "./stream-section-card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
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
import { usePathname, useRouter } from "next/navigation";
import { Scissors, Plus, RefreshCw } from "lucide-react";
import {
  listClipsAction,
  getClipAction,
  clipWindowAction,
  createClipAction,
  commandClipAction,
  bufferPolicyAction,
} from "@/actions/clips";
import { createAssetGrantAction } from "@/actions/recordings";
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
import type { ConsoleEnvironment } from "@/lib/console-types";
import type { ConsoleClip, ConsoleClipWindow } from "@/lib/streaming/clip-contracts";
import { RecordingPreview } from "./recording-preview";

export function ClipsManager({
  projectId,
  environmentId,
  environments,
  streams,
  canManage,
}: {
  projectId: string;
  environmentId: string;
  environments: readonly ConsoleEnvironment[];
  streams: { id: string; name: string }[];
  canManage: boolean;
}) {
  const workspace = useStreamWorkspace();
  const router = useRouter(),
    pathname = usePathname();
  const [streamId, setStreamId] = useState(workspace?.streamId ?? streams[0]?.id ?? ""),
    [rows, setRows] = useState<ConsoleClip[]>([]),
    [windows, setWindows] = useState<ConsoleClipWindow[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<ConsoleClip | null>(null),
    [remove, setRemove] = useState<ConsoleClip | null>(null),
    [download, setDownload] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState(""),
    [interval, setIntervalKind] = useState("last"),
    [seconds, setSeconds] = useState("30"),
    [start, setStart] = useState("0"),
    [end, setEnd] = useState("30"),
    [cutMode, setCutMode] = useState("keyframe"),
    [label, setLabel] = useState(""),
    [retention, setRetention] = useState("7");
  const [buffer, setBuffer] = useState({
      enabled: false,
      durationSeconds: 300,
      maxBytes: 134217728,
      consentAcknowledged: true,
    }),
    [version, setVersion] = useState(0),
    [consent, setConsent] = useState(false);
  const keys = useRef(new Map<string, string>()),
    revision = useRef(0),
    selectedId = useRef<string | null>(null),
    bufferDirty = useRef(false);
  const key = (command: string) => {
    const existing = keys.current.get(command) ?? crypto.randomUUID();
    keys.current.set(command, existing);
    return existing;
  };
  const refresh = useCallback(async () => {
    if (!streamId) return;
    const rev = ++revision.current;
    try {
      const scope = { projectId, environmentId, streamId };
      const [clips, window, policy, detail] = await Promise.all([
        listClipsAction(scope),
        clipWindowAction(scope),
        bufferPolicyAction(scope),
        selectedId.current
          ? getClipAction({ ...scope, clipId: selectedId.current })
          : Promise.resolve(null),
      ]);
      if (rev !== revision.current) return;
      if (clips.error) setError(clips.error.description);
      else {
        setRows((previous) =>
          [
            ...clips.data.data,
            ...previous.filter((p) => !clips.data.data.some((c) => c.id === p.id)),
          ].sort((a, b) => a.id.localeCompare(b.id)),
        );
        setCursor(clips.data.nextCursor);
        setSelected((previous) =>
          previous ? (clips.data.data.find((c) => c.id === previous.id) ?? previous) : null,
        );
      }
      if (detail?.data && detail.data.id === selectedId.current) setSelected(detail.data);
      if (window.data) setWindows(window.data.data);
      if (policy.data && !bufferDirty.current) {
        setVersion(policy.data.version);
        if (policy.data.policy) setBuffer(policy.data.policy);
      }
    } catch {
      if (rev === revision.current) setError("Clip status is unavailable. Try again.");
    }
  }, [projectId, environmentId, streamId]);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => {
      clearInterval(timer);
      invalidate();
    };
  }, [refresh, invalidate]);
  async function command(kind: "publish" | "delete", clip: ConsoleClip) {
    setPending(true);
    setError(null);
    const commandKey = `${kind}:${clip.id}`;
    try {
      const result = await commandClipAction({
        projectId,
        environmentId,
        clipId: clip.id,
        command: kind,
        idempotencyKey: key(commandKey),
      });
      if (result.error) setError(result.error.description);
      else {
        keys.current.delete(commandKey);
        setRemove(null);
        await refresh();
      }
    } catch {
      setError("Command could not be confirmed. Retry to check the same request.");
    } finally {
      setPending(false);
    }
  }
  async function create() {
    setPending(true);
    setError(null);
    try {
      const result = await createClipAction({
        projectId,
        environmentId,
        streamId,
        idempotencyKey: key("create"),
        configuration: {
          recordingId,
          interval:
            interval === "last"
              ? { kind: "last", seconds: Number(seconds) }
              : { kind: "media", startSeconds: Number(start), endSeconds: Number(end) },
          cutMode,
          label,
          retentionSeconds: Number(retention) * 86400,
        },
      });
      if (result.error) setError(result.error.description);
      else {
        keys.current.delete("create");
        setCreating(false);
        selectedId.current = result.data.id;
        setSelected(result.data);
        await refresh();
      }
    } catch {
      setError("Clip request could not be confirmed. Retry the same request.");
    } finally {
      setPending(false);
    }
  }
  async function saveBuffer() {
    setPending(true);
    setError(null);
    try {
      const result = await bufferPolicyAction({
        projectId,
        environmentId,
        streamId,
        idempotencyKey: key("buffer"),
        configuration: { version, policy: buffer },
      });
      if (result.error) setError(result.error.description);
      else {
        keys.current.delete("buffer");
        bufferDirty.current = false;
        setVersion(result.data.version);
      }
    } catch {
      setError("Buffer update could not be confirmed. Retry the same request.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Clips"
        description="Save highlights from a live buffer or recording."
        actions={
          <Button
            disabled={!canManage || !streamId || pending}
            onClick={() => {
              setCreating(true);
              setRecordingId(
                (windows.find((w) => w.broadcastId === workspace?.broadcastId) ?? windows[0])
                  ?.recordingId ?? "",
              );
            }}
          >
            <Plus />
            Create clip
          </Button>
        }
      />
      <div className="flex flex-wrap gap-3">
        {!workspace && (
          <SimpleSelect
            aria-label="Environment"
            value={environmentId}
            options={environments.map((e) => ({ value: e.id, label: e.name }))}
            onValueChange={(id) =>
              router.push(`${pathname}?environmentId=${encodeURIComponent(id)}`)
            }
          />
        )}
        {!workspace && (
          <SimpleSelect
            aria-label="Stream"
            value={streamId}
            options={streams.map((s) => ({ value: s.id, label: s.name }))}
            onValueChange={(id) => {
              keys.current.clear();
              selectedId.current = null;
              bufferDirty.current = false;
              setVersion(0);
              setBuffer({
                enabled: false,
                durationSeconds: 300,
                maxBytes: 134217728,
                consentAcknowledged: true,
              });
              setSelected(null);
              setRows([]);
              setWindows([]);
              setStreamId(id);
            }}
          />
        )}
        <Button variant="outline" onClick={() => void refresh()}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <StreamSectionCard
        title="Live rolling buffer"
        description={
          <>Enable before starting a broadcast. Retained media appears below as it arrives.</>
        }
      >
        <Label className="flex gap-2">
          <Switch
            checked={buffer.enabled}
            disabled={!canManage || pending}
            onCheckedChange={(e) => {
              bufferDirty.current = true;
              setBuffer({ ...buffer, enabled: e });
            }}
          />
          Enable buffer for this stream
        </Label>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="buffer-duration">Retain seconds</Label>
            <Input
              id="buffer-duration"
              type="number"
              min={30}
              max={1800}
              value={buffer.durationSeconds}
              disabled={!canManage || pending}
              onChange={(e) => {
                bufferDirty.current = true;
                setBuffer({ ...buffer, durationSeconds: Number(e.target.value) });
              }}
            />
          </div>
          <div>
            <Label htmlFor="buffer-bytes">Storage cap (MiB)</Label>
            <Input
              id="buffer-bytes"
              type="number"
              min={16}
              max={511}
              value={buffer.maxBytes / 1048576}
              disabled={!canManage || pending}
              onChange={(e) => {
                bufferDirty.current = true;
                setBuffer({ ...buffer, maxBytes: Number(e.target.value) * 1048576 });
              }}
            />
          </div>
          <Label className="flex gap-2">
            <Checkbox checked={consent} onCheckedChange={(e) => setConsent(e)} />I have consent to
            retain this media.
          </Label>
          <Button
            disabled={!canManage || !streamId || !consent || pending}
            onClick={() => void saveBuffer()}
          >
            Save buffer
          </Button>
        </div>
      </StreamSectionCard>
      <StreamSectionCard title="Retained intervals">
        {windows.length ? (
          windows.map((w) => (
            <p key={w.recordingId} className="text-sm">
              {w.kind}: {w.startSeconds.toFixed(1)}–{w.endSeconds.toFixed(1)} seconds · {w.state} ·{" "}
              {w.recordingId}
            </p>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No retained media yet. Start a recording or enable a buffer and start a broadcast.
          </p>
        )}
      </StreamSectionCard>
      <div className="overflow-x-auto rounded-xl border">
        <Table className="w-full text-sm">
          <TableHeader>
            <TableRow className="border-b text-left">
              <TableHead className="p-3">Clip</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Availability</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id} className="border-b">
                <TableCell className="p-3">
                  <Button
                    variant="link"
                    onClick={() => {
                      selectedId.current = c.id;
                      setSelected(c);
                      setDownload(null);
                    }}
                  >
                    <Scissors />
                    {c.label || c.id}
                  </Button>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{c.state}</Badge>
                  {c.lastError && <p className="text-destructive">{c.lastError}</p>}
                </TableCell>
                <TableCell>{c.durationSeconds.toFixed(1)}s</TableCell>
                <TableCell>{c.published ? "Published" : "Private preview"}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    disabled={!canManage || pending}
                    onClick={() => setRemove(c)}
                  >
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!rows.length && <p className="p-4 text-muted-foreground">No clips yet.</p>}
      </div>
      {cursor && (
        <Button
          onClick={async () => {
            const result = await listClipsAction({ projectId, environmentId, streamId, cursor });
            if (result.data) {
              setRows((previous) => [
                ...previous,
                ...result.data.data.filter((c) => !previous.some((p) => p.id === c.id)),
              ]);
              setCursor(result.data.nextCursor);
            } else setError(result.error.description);
          }}
        >
          Load more
        </Button>
      )}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Create clip</SheetTitle>
            <SheetDescription>Select retained media and a cut interval.</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 p-6">
            <Label>Recording or buffer</Label>
            <SimpleSelect
              value={recordingId}
              onValueChange={setRecordingId}
              options={windows.map((w) => ({
                value: w.recordingId,
                label: `${w.kind}: ${w.startSeconds.toFixed(1)}–${w.endSeconds.toFixed(1)}s`,
              }))}
            />
            <Label htmlFor="clip-label">Label</Label>
            <Input id="clip-label" value={label} onChange={(e) => setLabel(e.target.value)} />
            <SimpleSelect
              aria-label="Interval"
              value={interval}
              onValueChange={setIntervalKind}
              options={[
                { value: "last", label: "Last N seconds" },
                { value: "media", label: "Media interval" },
              ]}
            />
            {interval === "last" ? (
              <>
                <Label htmlFor="clip-seconds">Seconds</Label>
                <Input
                  id="clip-seconds"
                  type="number"
                  min={1}
                  max={120}
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                />
              </>
            ) : (
              <>
                <Label htmlFor="clip-start">Start seconds</Label>
                <Input
                  id="clip-start"
                  type="number"
                  min={0}
                  step="0.1"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
                <Label htmlFor="clip-end">End seconds</Label>
                <Input
                  id="clip-end"
                  type="number"
                  step="0.1"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </>
            )}
            <SimpleSelect
              aria-label="Cut accuracy"
              value={cutMode}
              onValueChange={setCutMode}
              options={[
                { value: "keyframe", label: "Fast: expand to segment keyframes" },
                { value: "precise", label: "Precise: re-encode selected interval" },
              ]}
            />
            <Label htmlFor="clip-retention">Retain days</Label>
            <Input
              id="clip-retention"
              type="number"
              min={1}
              max={90}
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
            />
            <Button disabled={pending || !recordingId} onClick={() => void create()}>
              Create clip
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            selectedId.current = null;
            setSelected(null);
          }
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selected?.label || "Clip"}</SheetTitle>
            <SheetDescription>Clips have their own retention and playback access.</SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="space-y-4 p-6">
              <Badge>{selected.state}</Badge>
              <p className="text-sm">
                Requested {selected.requestedStartSeconds.toFixed(2)}–
                {selected.requestedEndSeconds.toFixed(2)}s; segment boundaries{" "}
                {selected.resolvedStartSeconds.toFixed(2)}–{selected.resolvedEndSeconds.toFixed(2)}
                s.
              </p>
              <p className="text-sm">
                {selected.processingSeconds.toFixed(1)} processing seconds ·{" "}
                {(selected.storedBytes / 1048576).toFixed(1)} MiB · Expires{" "}
                {selected.expiresAt ?? "when rendering completes"}
              </p>
              {selected.state === "ready" && (
                <>
                  <RecordingPreview
                    projectId={projectId}
                    environmentId={environmentId}
                    recordingId={selected.recordingId}
                    assetId={selected.assetId}
                  />
                  <div className="flex gap-2">
                    <Button
                      disabled={!canManage || pending || selected.published}
                      onClick={() => void command("publish", selected)}
                    >
                      {selected.published ? "Published" : "Publish"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const result = await createAssetGrantAction({
                          projectId,
                          environmentId,
                          assetId: selected.assetId,
                          action: "download",
                          idempotencyKey: crypto.randomUUID(),
                        });
                        if (result.data) setDownload(result.data.url);
                        else setError(result.error.description);
                      }}
                    >
                      Prepare download
                    </Button>
                  </div>
                  {download && (
                    <a href={download} rel="noreferrer" className="underline">
                      Download MP4 (expires in five minutes)
                    </a>
                  )}
                  <p className="text-sm text-muted-foreground">
                    Publishing allows your application to request viewer grants. Objects remain
                    private.
                  </p>
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete clip?</AlertDialogTitle>
            <AlertDialogDescription>
              Revoke playback grants and remove this clip’s stored media. Source media stays
              available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => remove && void command("delete", remove)}
            >
              Delete clip
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
