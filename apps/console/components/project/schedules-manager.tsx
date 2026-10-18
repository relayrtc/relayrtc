"use client";
import { StreamTable } from "./stream-table";
import { localDateInput, localDateToIso } from "@/lib/streaming/setup";
import { StreamingTaskPage, useStreamingTask } from "./streaming-task-page";
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
import type { ScheduleTiming } from "@relayrtc/types";
import {
  listSchedulesAction,
  getScheduleAction,
  createScheduleAction,
  updateScheduleAction,
  commandScheduleAction,
} from "@/actions/schedules";
import type { ConsoleSchedule } from "@/lib/streaming/schedule-contracts";
import type { ConsoleEnvironment } from "@/lib/console-types";
import { StreamingHeader as PageHeader, StreamToolbar, StreamEmptyState } from "./stream-ui";
import { SimpleSelect } from "@/components/page/simple-select";
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
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { listDestinationsAction } from "@/actions/destinations";
import type { ConsoleDestination } from "@/lib/streaming/destination-contracts";
import { SchedulePreview } from "./schedule-preview";
const empty: ScheduleTiming = {
  startsAt: "",
  endsAt: "",
  timeZone: "UTC",
  sourceWaitSeconds: 120,
  catchUpSeconds: 300,
  publisherEarlySeconds: 900,
  viewerEarlySeconds: 900,
  viewerAfterSeconds: 0,
  notifyBeforeSeconds: null,
};
const localTime = (value: string, zone: string) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
};
export function SchedulesManager({
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
  initialRows: ConsoleSchedule[];
  initialCursor: string | null;
  initialError: string | null;
  initialLimits: { activeSchedules: number; maxActiveSchedules: number } | null;
}) {
  const task = useStreamingTask();
  const workspace = useStreamWorkspace();
  const [query, setQuery] = useState("");
  const scopedStreamId = workspace?.streamId;
  const [destinationOptions, setDestinationOptions] = useState<ConsoleDestination[]>([]);
  const [destinationsReady, setDestinationsReady] = useState(!scopedStreamId);
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const [rows, setRows] = useState(initialRows),
    [cursor, setCursor] = useState(initialCursor),
    [error, setError] = useState(initialError),
    [limits, setLimits] = useState(initialLimits),
    [pending, setPending] = useState(false),
    [form, setForm] = useState(false),
    [editing, setEditing] = useState<ConsoleSchedule | null>(null),
    [selected, setSelected] = useState<ConsoleSchedule | null>(null),
    [confirm, setConfirm] = useState(false);
  const [streamId, setStreamId] = useState(workspace?.streamId ?? ""),
    [name, setName] = useState(""),
    [destinations, setDestinations] = useState(""),
    [timing, setTiming] = useState<ScheduleTiming>(empty);
  const [browserZone, setBrowserZone] = useState("UTC");
  useEffect(() => {
    const timer = setTimeout(() => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setBrowserZone(zone);
      if (task.active) {
        setName(workspace?.stream.name ?? "");
        setTiming({
          ...empty,
          startsAt: new Date(Date.now() + 3600000).toISOString(),
          endsAt: new Date(Date.now() + 7200000).toISOString(),
          timeZone: zone,
        });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [task.active, workspace?.stream.name]);
  const mounted = useRef(true),
    sequence = useRef(0),
    keys = useRef(new Map<string, string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(
    async (next?: string) => {
      const version = ++sequence.current;
      const result = await listSchedulesAction({
        projectId,
        environmentId,
        ...(scopedStreamId ? { streamId: scopedStreamId } : {}),
        ...(next ? { cursor: next } : {}),
      });
      if (!mounted.current || version !== sequence.current) return;
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
      setLimits(result.data.limits);
      setError(null);
    },
    [projectId, environmentId, scopedStreamId],
  );
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const timer = setInterval(() => {
      void getScheduleAction({ projectId, environmentId, scheduleId: selectedId }).then(
        (result) => {
          if (active && result.data)
            setSelected((previous) => (previous?.id === result.data.id ? result.data : previous));
        },
      );
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, environmentId, selectedId]);
  const execute = async (command: "save" | "cancel" | "start-now") => {
    if (
      command === "save" &&
      (!timing.startsAt ||
        !timing.endsAt ||
        Date.parse(timing.endsAt) <= Date.parse(timing.startsAt))
    ) {
      setError("Choose a valid start and an end after it in your local time zone.");
      return;
    }
    setPending(true);
    setError(null);
    const identity = JSON.stringify({
      command,
      editingId: editing?.id,
      version: editing?.version,
      selectedId: selected?.id,
      selectedVersion: selected?.version,
      streamId,
      name,
      destinations,
      timing,
    });
    const idempotencyKey = keys.current.get(identity) ?? crypto.randomUUID();
    keys.current.set(identity, idempotencyKey);
    try {
      const scope = { projectId, environmentId, idempotencyKey };
      const result =
        command === "save"
          ? editing
            ? await updateScheduleAction({
                ...scope,
                scheduleId: editing.id,
                configuration: { version: editing.version, timing },
              })
            : await createScheduleAction({
                ...scope,
                configuration: {
                  broadcast: {
                    streamId,
                    name,
                    maxDurationSeconds: Math.max(
                      60,
                      Math.ceil((Date.parse(timing.endsAt) - Date.parse(timing.startsAt)) / 1000),
                    ),
                    destinationIds: destinations
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  },
                  timing,
                },
              })
          : selected
            ? await commandScheduleAction({
                ...scope,
                scheduleId: selected.id,
                version: selected.version,
                command,
              })
            : null;
      if (!result) return;
      if (result.error) {
        setError(result.error.description);
        return;
      }
      keys.current.delete(identity);
      setSelected(result.data);
      setForm(false);
      if (task.active) task.setOpen(false);
      setConfirm(false);
      await load();
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const openForm = (s?: ConsoleSchedule) => {
    setEditing(s ?? null);
    setStreamId(s?.streamId ?? workspace?.streamId ?? "");
    setName(s?.name ?? workspace?.stream.name ?? "");
    setDestinations("");
    setDestinationsReady(!!s || !scopedStreamId);
    setTiming(
      s
        ? {
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            timeZone: s.timeZone,
            sourceWaitSeconds: s.sourceWaitSeconds,
            catchUpSeconds: s.catchUpSeconds,
            publisherEarlySeconds: s.publisherEarlySeconds,
            viewerEarlySeconds: s.viewerEarlySeconds,
            viewerAfterSeconds: s.viewerAfterSeconds,
            notifyBeforeSeconds: s.notifyBeforeSeconds,
          }
        : {
            ...empty,
            startsAt: new Date(Date.now() + 3600000).toISOString(),
            endsAt: new Date(Date.now() + 7200000).toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
    );
    setForm(true);
    setError(null);
  };
  useEffect(() => {
    if ((!form && !task.active) || editing || !scopedStreamId) return;
    let active = true;
    void listDestinationsAction({ projectId, environmentId, streamId: scopedStreamId })
      .then((result) => {
        if (!active) return;
        if (result.error) setError(result.error.description);
        else {
          const enabled = result.data.data.filter((d) => d.enabled);
          setDestinationsReady(true);
          setDestinationOptions(enabled);
          setDestinations("");
        }
      })
      .catch(() => {
        if (active) setError("Destinations are unavailable. Try reopening the schedule.");
      });
    return () => {
      active = false;
    };
  }, [form, task.active, editing, projectId, environmentId, scopedStreamId]);
  const numericFields = [
    ["sourceWaitSeconds", "Wait for publisher (seconds)", 10, 600],
    ["catchUpSeconds", "Allow scheduler catch-up (seconds)", 0, 3600],
    ["publisherEarlySeconds", "Publisher may connect early (seconds)", 0, 3600],
    ["viewerEarlySeconds", "Waiting page opens early (seconds)", 0, 86400],
    ["viewerAfterSeconds", "Ended-event metadata remains available (seconds)", 0, 3600],
  ] as const;
  const visibleRows = rows.filter((row) =>
    `${row.name} ${row.id} ${row.state}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (task.active || form)
    return (
      <StreamingTaskPage
        title={editing ? "Edit schedule" : "Schedule a broadcast"}
        description="Choose when a broadcast starts and ends. Your publisher must be connected separately; scheduling does not activate a camera or encoder."
        backHref={task.backHref}
        onBack={task.active ? undefined : () => setForm(false)}
        guidance="Dates use your browser's time zone. Review the start and end below before saving. Platform destinations are optional; private playback is included."
      >
        {!canManage ? (
          <p>Management access is required.</p>
        ) : (
          <>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {!editing && (
              <>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="schedule-name">Name</Label>
                  <Input
                    id="schedule-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                {workspace ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Destinations</p>
                    {destinationOptions.length ? (
                      destinationOptions.map((d) => (
                        <Label key={d.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={destinations.split(",").includes(d.id)}
                            onCheckedChange={(e) =>
                              setDestinations((previous) =>
                                e
                                  ? [...previous.split(",").filter(Boolean), d.id].join(",")
                                  : previous
                                      .split(",")
                                      .filter((id) => id !== d.id)
                                      .join(","),
                              )
                            }
                          />
                          {d.name}
                        </Label>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No enabled destinations. Private playback is still available.
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    {" "}
                    <div className="grid min-w-0 gap-2">
                      <Label htmlFor="schedule-stream">Stream ID</Label>
                      <Input
                        id="schedule-stream"
                        value={streamId}
                        onChange={(e) => setStreamId(e.target.value)}
                      />
                    </div>
                    <div className="grid min-w-0 gap-2">
                      <Label htmlFor="schedule-destinations">
                        Destination IDs (optional, comma separated)
                      </Label>
                      <Input
                        id="schedule-destinations"
                        value={destinations}
                        onChange={(e) => setDestinations(e.target.value)}
                      />
                    </div>
                  </>
                )}
              </>
            )}
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="schedule-start">Start (your local time)</Label>
              <Input
                id="schedule-start"
                type="datetime-local"
                value={localDateInput(timing.startsAt)}
                onChange={(e) =>
                  setTiming({
                    ...timing,
                    startsAt: localDateToIso(e.target.value),
                    timeZone: browserZone,
                  })
                }
              />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="schedule-end">End (your local time)</Label>
              <Input
                id="schedule-end"
                type="datetime-local"
                value={localDateInput(timing.endsAt)}
                onChange={(e) =>
                  setTiming({
                    ...timing,
                    endsAt: localDateToIso(e.target.value),
                    timeZone: browserZone,
                  })
                }
              />
            </div>
            <div className="rounded-xl border bg-muted/20 p-4 text-sm space-y-2">
              <p>
                Time zone: <strong>{browserZone}</strong>
              </p>
              {timing.startsAt && <p>Starts {localTime(timing.startsAt, browserZone)}</p>}
              {timing.endsAt && <p>Ends {localTime(timing.endsAt, browserZone)}</p>}
              {timing.startsAt && (
                <p className="text-xs text-muted-foreground">
                  UTC reference: {timing.startsAt}. During a repeated daylight-saving hour, the
                  earlier occurrence is selected.
                </p>
              )}
            </div>
            <details className="rounded-lg border border-border/70 p-4">
              <summary className="cursor-pointer text-sm font-medium">Advanced timing</summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {" "}
                {numericFields.map(([field, label, min, max]) => (
                  <div key={field} className="space-y-2">
                    <Label htmlFor={`schedule-${field}`}>{label}</Label>
                    <Input
                      id={`schedule-${field}`}
                      type="number"
                      min={min}
                      max={max}
                      value={timing[field]}
                      onChange={(e) => setTiming({ ...timing, [field]: Number(e.target.value) })}
                    />
                  </div>
                ))}
              </div>
            </details>
            <Label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={timing.notifyBeforeSeconds !== null}
                onCheckedChange={(e) =>
                  setTiming({ ...timing, notifyBeforeSeconds: e ? 300 : null })
                }
              />
              Queue a reminder through the configured signed webhook provider
            </Label>
            {timing.notifyBeforeSeconds !== null && (
              <>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="schedule-reminder">Reminder lead (seconds)</Label>
                  <Input
                    id="schedule-reminder"
                    type="number"
                    min={30}
                    max={86400}
                    value={timing.notifyBeforeSeconds}
                    onChange={(e) =>
                      setTiming({ ...timing, notifyBeforeSeconds: Number(e.target.value) })
                    }
                  />
                </div>
              </>
            )}
            <Button
              disabled={
                pending ||
                !destinationsReady ||
                !timing.startsAt ||
                !timing.endsAt ||
                (!editing && (!streamId || !name))
              }
              onClick={() => {
                void execute("save");
              }}
            >
              Save schedule
            </Button>
          </>
        )}
      </StreamingTaskPage>
    );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="Schedules"
        description="Schedule broadcasts and track their start and end times."
        actions={
          canManage && (
            <Button size="lg" disabled={!environmentId} onClick={() => task.setOpen(true)}>
              <Plus />
              Schedule broadcast
            </Button>
          )
        }
      />
      <StreamToolbar>
        <Input
          type="search"
          aria-label="Search schedules"
          placeholder="Search schedules..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full bg-background sm:max-w-xs"
        />
        {!workspace && (
          <SimpleSelect
            aria-label="Environment"
            value={environmentId}
            options={environments.map((e) => ({ value: e.id, label: e.name }))}
            onValueChange={(value) => {
              const p = new URLSearchParams(search.toString());
              p.set("environmentId", value);
              router.push(`${pathname}?${p}`);
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
      </StreamToolbar>
      {limits && (
        <p className="text-sm text-muted-foreground">
          Active schedules: {limits.activeSchedules}/{limits.maxActiveSchedules}. Live output
          capacity is checked when each event starts.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <StreamTable>
        <Table hidden={!visibleRows.length} className="w-full text-left text-sm">
          <TableHeader>
            <TableRow className="border-b">
              <TableHead className="p-4">Event</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...visibleRows]
              .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
              .map((s) => (
                <TableRow key={s.id} className="border-b last:border-0">
                  <TableCell className="p-4">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">{s.streamId}</p>
                  </TableCell>
                  <TableCell>
                    <p>{localTime(s.startsAt, s.timeZone)}</p>
                    <p className="text-xs text-muted-foreground">{s.timeZone}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="capitalize">
                      {s.state === "starting" ? "Waiting for publisher" : s.state}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" onClick={() => setSelected(s)}>
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        {!visibleRows.length && (
          <StreamEmptyState
            className="border-0 bg-transparent"
            title={query ? "No matches found" : "No schedules yet"}
            description={
              query
                ? "Try a different search. Load more items to expand your results."
                : "Schedule your next broadcast and it will appear here."
            }
          />
        )}
      </StreamTable>
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

      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selected?.name}</SheetTitle>
            <SheetDescription>{selected?.id}</SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="space-y-4 px-4 pb-6">
              <Badge variant="secondary" className="capitalize">
                {selected.state === "starting" ? "Waiting for publisher" : selected.state}
              </Badge>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {selected.lastError && (
                <p role="status" className="text-sm text-destructive">
                  {selected.lastError.replaceAll("_", " ").toLowerCase()}
                </p>
              )}
              <p className="text-sm">
                The publisher must connect separately. Scheduling cannot activate a camera or OBS.
              </p>
              {selected.state === "running" && (
                <SchedulePreview
                  projectId={projectId}
                  environmentId={environmentId}
                  scheduleId={selected.id}
                />
              )}
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt>Start</dt>
                <dd>{localTime(selected.startsAt, selected.timeZone)}</dd>
                <dt>End</dt>
                <dd>{localTime(selected.endsAt, selected.timeZone)}</dd>
                <dt>Time zone</dt>
                <dd>{selected.timeZone}</dd>
                <dt>UTC start</dt>
                <dd>{selected.startsAt}</dd>
                <dt>Publisher access opens</dt>
                <dd>{localTime(selected.publisherOpensAt, selected.timeZone)}</dd>
                <dt>Viewer waiting page opens</dt>
                <dd>{localTime(selected.viewerOpensAt, selected.timeZone)}</dd>
                <dt>Source deadline</dt>
                <dd>{localTime(selected.readinessDeadline, selected.timeZone)}</dd>
                <dt>Broadcast</dt>
                <dd className="break-all">{selected.broadcastId}</dd>
                <dt>Operation</dt>
                <dd className="break-all">{selected.operationId}</dd>
                <dt>Version</dt>
                <dd>{selected.version}</dd>
              </dl>
              {canManage && selected.state === "scheduled" && (
                <div className="flex gap-2">
                  <Button disabled={pending} variant="outline" onClick={() => openForm(selected)}>
                    Edit
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      void execute("start-now");
                    }}
                  >
                    Start now
                  </Button>
                </div>
              )}
              {canManage &&
                ["scheduled", "starting", "running", "ending"].includes(selected.state) && (
                  <Button disabled={pending} variant="destructive" onClick={() => setConfirm(true)}>
                    Cancel event
                  </Button>
                )}
              {selected.state === "scheduled" && (
                <p className="text-xs text-muted-foreground">
                  Rescheduling or starting now revokes previously issued event credentials. Start
                  now preserves duration and moves the end time.
                </p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this event?</AlertDialogTitle>
            <AlertDialogDescription>
              Event grants are revoked immediately. Any started broadcast drains its outputs.
              Schedule-scoped ingest stops; independent room publishers keep control of their
              devices.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(false)}>
              Keep event
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void execute("cancel");
              }}
            >
              Cancel event
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
