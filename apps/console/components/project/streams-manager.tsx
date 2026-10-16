"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Radio, RefreshCw } from "lucide-react";
import {
  commandStreamAction,
  createIngestCredentialAction,
  getStreamAction,
  getStreamingOperationAction,
  getStreamUsageAction,
  listStreamsAction,
  saveStreamAction,
} from "@/actions/streaming";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { CopyButton } from "@/components/page/copy-button";
import { StreamPreview } from "@/components/project/stream-preview";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ConsoleEnvironment } from "@/lib/console-types";
import type {
  ConsoleIngestCredential,
  ConsoleStream,
  ConsoleStreamDetail,
  ConsoleStreamingOperation,
} from "@/lib/streaming/contracts";

export function StreamsManager({
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
  initialRows: ConsoleStream[];
  initialCursor: string | null;
  initialError: string | null;
}) {
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const [rows, setRows] = useState<ConsoleStream[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);
  const [editor, setEditor] = useState<{ stream: ConsoleStream | null } | null>(null);
  const [selected, setSelected] = useState<ConsoleStreamDetail | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    stream: ConsoleStream;
    command: "start" | "stop" | "delete";
    key: string;
  } | null>(null);
  const [operation, setOperation] = useState<ConsoleStreamingOperation | null>(null);
  const [credential, setCredential] = useState<ConsoleIngestCredential | null>(null);
  const [reveal, setReveal] = useState(false);
  const mounted = useRef(true),
    sequence = useRef(0);
  const credentialSequence = useRef(0);
  const credentialCommand = useRef<{
    streamId: string;
    credentialId?: string;
    idempotencyKey: string;
  } | null>(null);
  const scope = { projectId, environmentId };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (next?: string) => {
      const current = ++sequence.current;
      setPending(true);
      try {
        const result = await listStreamsAction({
          projectId,
          environmentId,
          ...(next ? { cursor: next } : {}),
        });
        if (!mounted.current || current !== sequence.current) return;
        if (result.error) setError(result.error.description);
        else {
          setRows((previous) => (next ? [...previous, ...result.data.data] : result.data.data));
          setCursor(result.data.nextCursor);
          setError(null);
        }
      } catch {
        if (mounted.current) setError("Streams are unavailable. Try again.");
      } finally {
        if (mounted.current && current === sequence.current) setPending(false);
      }
    },
    [projectId, environmentId],
  );

  const operationId = operation?.id,
    operationStatus = operation?.status;

  useEffect(() => {
    if (!operationId || operationStatus !== "pending") return;
    let active = true,
      busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void getStreamingOperationAction({ projectId, environmentId, operationId })
        .then((result) => {
          if (!active) return;
          if (result.error) setError(result.error.description);
          else {
            setOperation(result.data);
            if (result.data.status !== "pending") void load();
          }
        })
        .catch(() => {
          if (active) setError("Operation status is unavailable. Retry refresh.");
        })
        .finally(() => {
          busy = false;
        });
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [operationId, operationStatus, projectId, environmentId, load]);

  const selectedId = selected?.id;

  useEffect(() => {
    if (!selectedId) return;
    let active = true,
      busy = false;
    const streamId = selectedId;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const [detail, measurement] = await Promise.all([
          getStreamAction({ projectId, environmentId, streamId }),
          getStreamUsageAction({ projectId, environmentId, streamId }),
        ]);
        if (!active) return;
        if (detail.data) setSelected(detail.data);
        else setError(detail.error.description);
        if (measurement.data)
          setUsage(
            `${Math.round(measurement.data.sourceSeconds)} source seconds; ${measurement.data.ingressBytes} ingress bytes; ${measurement.data.programBytes} program bytes; ${measurement.data.coverage} coverage`,
          );
      } catch {
        if (active) setError("Source health is unavailable.");
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedId, projectId, environmentId]);

  async function inspect(streamId: string) {
    credentialSequence.current++;
    credentialCommand.current = null;
    setCredential(null);
    setReveal(false);
    setPending(true);
    setUsage(null);
    try {
      const result = await getStreamAction({ ...scope, streamId });
      if (mounted.current) {
        if (result.error) setError(result.error.description);
        else setSelected(result.data);
      }
    } catch {
      setError("Stream details are unavailable.");
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function confirm() {
    if (!confirmation) return;
    setPending(true);
    try {
      const result = await commandStreamAction({
        ...scope,
        streamId: confirmation.stream.id,
        command: confirmation.command,
        idempotencyKey: confirmation.key,
      });
      if (result.error) setError(result.error.description);
      else {
        setOperation(result.data);
        setConfirmation(null);
        setError(null);
        await load();
      }
    } catch {
      setError("Command failed. Retry with the same confirmation.");
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function issue(stream: ConsoleStream, credentialId?: string) {
    const current = ++credentialSequence.current;
    const command =
      credentialCommand.current?.streamId === stream.id
        ? credentialCommand.current
        : {
            streamId: stream.id,
            idempotencyKey: crypto.randomUUID(),
            ...(credentialId ? { credentialId } : {}),
          };
    credentialCommand.current = command;
    setCredential(null);
    setReveal(false);
    setPending(true);
    try {
      const result = await createIngestCredentialAction({
        ...scope,
        ...command,
      });
      if (!mounted.current || current !== credentialSequence.current) return;
      if (result.error) setError(result.error.description);
      else {
        credentialCommand.current = null;
        setCredential(result.data);
        setReveal(false);
      }
    } catch {
      if (mounted.current && current === credentialSequence.current)
        setError("Ingest credential is unavailable.");
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Streams"
        description="Configure RTC, WHIP and RTMP sources with private live playback."
      />
      <div className="flex flex-wrap items-center gap-3">
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
          <Button disabled={!environmentId || pending} onClick={() => setEditor({ stream: null })}>
            <Plus />
            Create stream
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!environmentId && <p>Create an active environment to configure streams.</p>}
      {operation && (
        <p role="status" className="text-sm">
          {operation.kind}: {operation.status} <span className="font-mono">{operation.id}</span>
          {operation.errorCode ? ` (${operation.errorCode})` : ""}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="p-4">Source</th>
              <th>Status</th>
              <th>Profile</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((stream) => (
              <tr key={stream.id} className="border-b last:border-0">
                <td className="p-4">
                  <button
                    className="flex items-center gap-2 font-medium"
                    onClick={() => {
                      void inspect(stream.id);
                    }}
                  >
                    <Radio className="size-4" />
                    {stream.name}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {stream.source.kind} · {stream.id}
                  </p>
                </td>
                <td>
                  <Badge variant="outline">{stream.status}</Badge>
                </td>
                <td>
                  {stream.profile.audioOnly
                    ? "Audio only"
                    : `${stream.profile.width}×${stream.profile.height}`}{" "}
                  · {stream.profile.layout}
                </td>
                <td className="space-x-2 p-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      void inspect(stream.id);
                    }}
                  >
                    Details
                  </Button>
                  {canManage && stream.status === "active" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setEditor({ stream })}
                      >
                        Edit
                      </Button>
                      {stream.source.kind === "room" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            setConfirmation({ stream, command: "start", key: crypto.randomUUID() })
                          }
                        >
                          Start
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setSelected({ ...stream, sessions: [] });
                            void issue(stream);
                          }}
                        >
                          Encoder setup
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          setConfirmation({ stream, command: "stop", key: crypto.randomUUID() })
                        }
                      >
                        Stop
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() =>
                          setConfirmation({ stream, command: "delete", key: crypto.randomUUID() })
                        }
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="p-4 text-sm text-muted-foreground">
            {pending ? "Loading streams…" : "No streams in this environment."}
          </p>
        )}
      </div>
      {cursor && (
        <Button
          disabled={pending}
          variant="outline"
          onClick={() => {
            void load(cursor);
          }}
        >
          Load more
        </Button>
      )}
      <Sheet
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editor?.stream ? "Edit stream" : "Create stream"}</SheetTitle>
            <SheetDescription>
              Stop the source before editing. Changes invalidate playback grants.
            </SheetDescription>
          </SheetHeader>
          {editor && (
            <StreamForm
              key={editor.stream?.id ?? "new"}
              stream={editor.stream}
              projectId={projectId}
              environmentId={environmentId}
              onSaved={() => {
                setEditor(null);
                void load();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            credentialSequence.current++;
            credentialCommand.current = null;
            setSelected(null);
            setCredential(null);
            setReveal(false);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>
              Private preview and source health. Preview does not join the RTC room.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <StreamPreview {...scope} streamId={selected.id} />
              <p className="text-sm">{usage ?? "Source usage is loading."}</p>
              {selected.sessions.map((session) => (
                <div key={session.id} className="rounded-lg border p-3 text-sm">
                  <Badge variant="outline">{session.state}</Badge>
                  <p>
                    Generation {session.generation}; attempts {session.attempts}
                  </p>
                  <p>
                    Ingress {session.ingressBitrate} bit/s; program {session.programBitrate} bit/s
                  </p>
                  {session.lastError && <p role="status">{session.lastError}</p>}
                  <p>
                    {session.sourceInfo.tracks
                      .map((track) => `${track.kind}: ${track.codec}`)
                      .join(", ")}
                  </p>
                </div>
              ))}
              {canManage && selected.source.kind !== "room" && (
                <Button
                  disabled={pending}
                  onClick={() => {
                    void issue(selected, credential?.id);
                  }}
                >
                  {credential
                    ? "Rotate credential and stop current publisher"
                    : "Issue encoder credential"}
                </Button>
              )}
              {credential && (
                <div className="space-y-2 rounded-lg border p-3 text-sm">
                  <p>
                    Expires {credential.expiresAt}. Save now; closing this window clears the secret.
                  </p>
                  <p className="break-all">
                    Ingest URL: {credential.url} <CopyButton value={credential.url} />
                  </p>
                  <p className="break-all">
                    Secret: {reveal ? credential.secret : "••••••••••••••••"}{" "}
                    <Button size="sm" variant="outline" onClick={() => setReveal(!reveal)}>
                      {reveal ? "Hide" : "Reveal"}
                    </Button>{" "}
                    <CopyButton value={credential.secret} />
                  </p>
                  <p>
                    {credential.protocol === "whip"
                      ? "Send the secret as a Bearer token to the WHIP URL."
                      : "Use the returned URL as the OBS server. Enable authentication with username publisher and this secret as the password; leave the stream key blank when the encoder supports a complete path."}
                  </p>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.command} {confirmation?.stream.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.command === "delete"
                ? "Retire the stream, revoke credentials and remove retained private media. Historical audit and usage remain."
                : confirmation?.command === "stop"
                  ? "Stop the source and revoke playback access. The RTC room remains active."
                  : "Queue a source session for this RTC room."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                void confirm();
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

function StreamForm({
  stream,
  projectId,
  environmentId,
  onSaved,
}: {
  stream: ConsoleStream | null;
  projectId: string;
  environmentId: string;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState(stream?.source.kind ?? "room");
  const [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const key = useRef(crypto.randomUUID());
  const profile = stream?.profile;
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const number = (name: string) => Number(form.get(name));
        const ids = (name: string) =>
          String(form.get(name) ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const configuration = {
          name: String(form.get("name")),
          source:
            kind === "room"
              ? {
                  kind,
                  roomId: String(form.get("roomId")),
                  videoTrackIds: ids("videoTrackIds"),
                  audioTrackIds: ids("audioTrackIds"),
                }
              : { kind },
          profile: {
            audioOnly: form.get("audioOnly") === "on",
            width: number("width"),
            height: number("height"),
            fps: number("fps"),
            videoBitrate: number("videoBitrate"),
            audioBitrate: number("audioBitrate"),
            layout: String(form.get("layout")),
          },
          maxDurationSeconds: number("maxDurationSeconds"),
          retentionSeconds: number("retentionSeconds"),
          ...(stream ? { version: stream.version } : {}),
        };
        setPending(true);
        void saveStreamAction({
          projectId,
          environmentId,
          configuration,
          ...(stream ? { streamId: stream.id } : {}),
          idempotencyKey: key.current,
        })
          .then((result) => {
            if (result.error) setError(result.error.description);
            else onSaved();
          })
          .catch(() => setError("Save failed. Retry or refresh the current configuration."))
          .finally(() => setPending(false));
      }}
    >
      <Label htmlFor="stream-name">Name</Label>
      <Input id="stream-name" name="name" required maxLength={120} defaultValue={stream?.name} />
      <Label htmlFor="source-kind">Source</Label>
      <SimpleSelect
        id="source-kind"
        value={kind}
        onValueChange={(value) => setKind(value as typeof kind)}
        options={["room", "whip", "rtmp"].map((value) => ({ value, label: value.toUpperCase() }))}
      />
      {kind === "room" && (
        <>
          <Label htmlFor="stream-room">Room ID</Label>
          <Input
            id="stream-room"
            name="roomId"
            required
            defaultValue={stream?.source.kind === "room" ? stream.source.roomId : ""}
          />
          {(["videoTrackIds", "audioTrackIds"] as const).map((name) => (
            <div key={name}>
              <Label htmlFor={name}>
                {name === "videoTrackIds" ? "Video track IDs" : "Audio track IDs"} (comma separated,
                optional)
              </Label>
              <Input
                id={name}
                name={name}
                defaultValue={stream?.source.kind === "room" ? stream.source[name].join(",") : ""}
              />
            </div>
          ))}
        </>
      )}
      <Label className="flex items-center gap-2">
        <input type="checkbox" name="audioOnly" defaultChecked={profile?.audioOnly} />
        Audio only
      </Label>
      <Label htmlFor="stream-layout">Layout</Label>
      <select
        id="stream-layout"
        name="layout"
        className="w-full rounded-md border p-2"
        defaultValue={profile?.layout ?? "single"}
      >
        <option value="single">Single</option>
        <option value="grid">Grid</option>
      </select>
      {(
        [
          ["width", "Width", profile?.width ?? 1280, 320, 1920, 2],
          ["height", "Height", profile?.height ?? 720, 180, 1080, 2],
          ["fps", "Frames per second", profile?.fps ?? 30, 15, 30, 1],
          ["videoBitrate", "Video bit/s", profile?.videoBitrate ?? 2500000, 200000, 6000000, 1],
          ["audioBitrate", "Audio bit/s", profile?.audioBitrate ?? 128000, 64000, 192000, 1],
          [
            "maxDurationSeconds",
            "Maximum source seconds",
            stream?.maxDurationSeconds ?? 14400,
            60,
            86400,
            1,
          ],
          [
            "retentionSeconds",
            "Live media retention seconds",
            stream?.retentionSeconds ?? 300,
            60,
            86400,
            1,
          ],
        ] as const
      ).map(([name, label, value, min, max, step]) => (
        <div key={name}>
          <Label htmlFor={`stream-${name}`}>{label}</Label>
          <Input
            id={`stream-${name}`}
            name={name}
            type="number"
            required
            min={min}
            max={max}
            step={step}
            defaultValue={value}
          />
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save stream"}
      </Button>
    </form>
  );
}
