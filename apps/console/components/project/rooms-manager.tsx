"use client";
import { StreamingTaskPage, useStreamingTask } from "./streaming-task-page";
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
import { Copy, Plus, RefreshCw } from "lucide-react";
import { createRoomAction, getRoomAction, listRoomsAction } from "@/actions/rooms";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { ConsoleEnvironment } from "@/lib/console-types";
import {
  roomConfigurationSchema,
  type ConsoleRoom,
  type RoomListCursor,
} from "@/lib/rooms/contracts";

const statuses = ["all", "created", "active", "ending", "ended", "failed"];

export function RoomsManager({
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
  initialRows: ConsoleRoom[];
  initialCursor: RoomListCursor | null;
  initialError: string | null;
}) {
  const task = useStreamingTask();
  const creating = task.active,
    setCreating = task.setOpen;
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const [rows, setRows] = useState(initialRows),
    [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState(initialError),
    [filter, setFilter] = useState("all");
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<ConsoleRoom | null>(null);
  const sequence = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    const requests = sequence;
    mounted.current = true;
    return () => {
      mounted.current = false;
      requests.current++;
    };
  }, []);
  const load = useCallback(
    async (next?: RoomListCursor, status = filter) => {
      const current = ++sequence.current;
      setPending(true);
      try {
        const result = await listRoomsAction({
          projectId,
          environmentId,
          ...(next ? { cursor: next } : {}),
          ...(status === "all" ? {} : { status }),
        });
        if (!mounted.current || current !== sequence.current) return;
        if (result.error) setError(result.error.description);
        else {
          setRows((old) => (next ? [...old, ...result.data.rooms] : result.data.rooms));
          setCursor(result.data.nextCursor);
          setError(null);
        }
      } catch {
        if (mounted.current && current === sequence.current)
          setError("Rooms are unavailable. Please try again.");
      } finally {
        if (mounted.current && current === sequence.current) setPending(false);
      }
    },
    [projectId, environmentId, filter],
  );

  if (creating)
    return (
      <StreamingTaskPage
        title="Create a room"
        description="Create a real-time space for your application's participants. They join and publish through your app; creating a room does not start a call."
        backHref={task.backHref}
        guidance="For a guest broadcast, use a dedicated room with 2?4 seats, including the host. Room capacity limits stage participants; it does not set the number of HLS viewers."
      >
        {canManage ? (
          <RoomForm
            projectId={projectId}
            environmentId={environmentId}
            onSaved={() => setCreating(false)}
          />
        ) : (
          <p>Management access is required.</p>
        )}
      </StreamingTaskPage>
    );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Rooms"
        description="Create and configure real-time rooms for your applications."
      />
      <div className="flex flex-wrap items-center gap-3">
        <SimpleSelect
          aria-label="Environment"
          value={environmentId}
          placeholder="Select environment"
          options={environments.map((item) => ({ value: item.id, label: item.name }))}
          onValueChange={(value) => {
            const query = new URLSearchParams(search);
            query.set("environmentId", value);
            router.push(`${pathname}?${query}`);
          }}
        />
        <SimpleSelect
          aria-label="Room status"
          value={filter}
          options={statuses.map((value) => ({
            value,
            label: value === "all" ? "All statuses" : value,
          }))}
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
          <Button disabled={!environmentId} onClick={() => setCreating(true)}>
            <Plus />
            Create room
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!environmentId ? (
        <p className="text-sm text-muted-foreground">
          Create an active environment to manage rooms.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border" aria-busy={pending}>
            <Table className="w-full text-left text-sm">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="p-4">Room</TableHead>
                  <TableHead className="p-4">Status</TableHead>
                  <TableHead className="p-4">Participant limit</TableHead>
                  <TableHead className="p-4">Created</TableHead>
                  <TableHead className="p-4">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((room) => (
                  <TableRow key={room.id} className="border-b last:border-0">
                    <TableCell className="p-4">
                      <p className="font-medium">{room.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{room.id}</p>
                    </TableCell>
                    <TableCell className="p-4">
                      <Badge variant="outline">{room.status}</Badge>
                    </TableCell>
                    <TableCell className="p-4">{room.maxParticipants}</TableCell>
                    <TableCell className="whitespace-nowrap p-4">
                      <time dateTime={room.createdAt}>
                        {room.createdAt.replace("T", " ").slice(0, 19)} UTC
                      </time>
                    </TableCell>
                    <TableCell className="p-4">
                      <Button variant="outline" size="sm" onClick={() => setSelected(room)}>
                        Details
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!rows.length && (
              <p className="p-6 text-sm text-muted-foreground">
                {pending
                  ? "Loading rooms..."
                  : "No rooms match this selection. Create a room or choose another environment."}
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
          <p className="text-sm text-muted-foreground">
            Your app can list and join these rooms using the SDKs in the same project and
            environment.
          </p>
        </>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.name ?? "Room details"}</DialogTitle>
            <DialogDescription>
              Room configuration and identifiers for your application.
            </DialogDescription>
          </DialogHeader>
          {selected && <RoomDetails key={selected.id} initialRoom={selected} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoomForm({
  projectId,
  environmentId,
  onSaved,
}: {
  projectId: string;
  environmentId: string;
  onSaved: (room: ConsoleRoom) => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null),
    submitting = useRef(false);
  return (
    <form
      className="space-y-4 p-4"
      onChange={() => {
        requestId.current = null;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting.current) return;
        const form = new FormData(event.currentTarget);
        let metadata: unknown;
        try {
          metadata = JSON.parse(String(form.get("metadata") || "{}"));
        } catch {
          setError('Metadata must be a valid JSON object, for example {"topic": "support"}.');
          return;
        }
        const parsed = roomConfigurationSchema.safeParse({
          name: form.get("name"),
          maxParticipants: Number(form.get("maxParticipants")),
          metadata,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Check the room configuration.");
          return;
        }
        submitting.current = true;
        setPending(true);
        setError(null);
        requestId.current ??= crypto.randomUUID();
        void createRoomAction({
          projectId,
          environmentId,
          requestId: requestId.current,
          configuration: parsed.data,
        })
          .then((result) => {
            if (result.error) setError(result.error.description);
            else onSaved(result.data);
          })
          .catch(() => setError("Creation failed. Retry to check whether the room was created."))
          .finally(() => {
            submitting.current = false;
            setPending(false);
          });
      }}
    >
      <fieldset disabled={pending} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="room-name">Name</Label>
          <Input id="room-name" name="name" required maxLength={120} autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="room-limit">Maximum participants</Label>
          <Input
            id="room-limit"
            name="maxParticipants"
            type="number"
            min={1}
            max={100000}
            step={1}
            defaultValue={100}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="room-metadata">Metadata (JSON)</Label>
          <Textarea
            id="room-metadata"
            name="metadata"
            defaultValue="{}"
            maxLength={16000}
            className="min-h-32 font-mono"
            aria-describedby="room-metadata-help"
          />
          <p id="room-metadata-help" className="text-xs text-muted-foreground">
            Optional application data, such as a topic or external meeting ID.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating..." : "Create room"}
        </Button>
      </fieldset>
    </form>
  );
}

function RoomDetails({ initialRoom }: { initialRoom: ConsoleRoom }) {
  const [room, setRoom] = useState(initialRoom),
    [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function refresh() {
    setPending(true);
    setMessage(null);
    try {
      const result = await getRoomAction({
        projectId: room.projectId,
        environmentId: room.environmentId,
        roomId: room.id,
      });
      if (!mounted.current) return;
      if (result.error) setMessage(result.error.description);
      else setRoom(result.data);
    } catch {
      if (mounted.current) setMessage("Room details are unavailable. Please try again.");
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function copyId() {
    try {
      await navigator.clipboard.writeText(room.id);
      if (mounted.current) setMessage("Room ID copied.");
    } catch {
      if (mounted.current) setMessage("Copy the room ID from the details below.");
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{room.status}</Badge>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            void refresh();
          }}
        >
          <RefreshCw />
          Refresh details
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copyId();
          }}
        >
          <Copy />
          Copy room ID
        </Button>
      </div>
      <dl className="grid gap-3 text-sm">
        {[
          ["Room ID", room.id],
          ["Project ID", room.projectId],
          ["Environment ID", room.environmentId],
          ["Maximum participants", String(room.maxParticipants)],
          ["Created", room.createdAt],
          ["Started", room.startedAt ?? "Not started"],
          ["Ended", room.endedAt ?? "Not ended"],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono text-xs">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        <p className="text-sm font-medium">Metadata</p>
        <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs">
          {JSON.stringify(room.metadata, null, 2)}
        </pre>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
