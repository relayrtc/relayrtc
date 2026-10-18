"use client";
import { StreamingTaskPage, useStreamingTask } from "./streaming-task-page";
import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, Video, Gamepad2, Link2, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import {
  listDestinationsAction,
  createDestinationAction,
  updateDestinationAction,
  rotateDestinationSecretAction,
  deleteDestinationAction,
} from "@/actions/destinations";
import { StreamingHeader, StreamToolbar, StreamEmptyState } from "./stream-ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/page/simple-select";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import type { ConsoleDestination } from "@/lib/streaming/destination-contracts";
type Scope = { projectId: string; environmentId: string; streamId: string };
export function DestinationsManager({
  canManage,
  projectId,
  environmentId,
  streamId,
}: Scope & { canManage: boolean }) {
  const task = useStreamingTask();
  const scope = { projectId, environmentId, streamId };
  const [rows, setRows] = useState<ConsoleDestination[]>([]),
    [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false),
    [form, setForm] = useState<{
      mode: "create" | "edit" | "rotate";
      row?: ConsoleDestination;
      suggestedName?: string;
    } | null>(null);
  const [removing, setRemoving] = useState<ConsoleDestination | null>(null);
  const sequence = useRef(0),
    mounted = useRef(true);
  const removeKey = useRef<string | null>(null);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setPending(true);
    try {
      const result = await listDestinationsAction({ projectId, environmentId, streamId });
      if (!mounted.current || current !== sequence.current) return;
      if (result.error) setError(result.error.description);
      else {
        setRows(result.data.data);
        setError(null);
      }
    } catch {
      if (mounted.current) setError("Destinations are unavailable. Try again.");
    } finally {
      if (mounted.current && current === sequence.current) setPending(false);
    }
  }, [projectId, environmentId, streamId, setPending, setError, setRows]);
  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [load]);
  if (task.active || form)
    return (
      <StreamingTaskPage
        title={
          form?.mode === "rotate"
            ? "Replace stream key"
            : form?.mode === "edit"
              ? "Edit destination"
              : "Add a destination"
        }
        description="Send this stream to an external platform using the server URL and stream key provided by that platform."
        guidance="Destinations send video to external platforms. Changes apply to new broadcasts. Stop an active broadcast to disconnect its current destinations."
        backHref={task.backHref}
        onBack={task.active ? undefined : () => setForm(null)}
      >
        {!canManage ? (
          <p>Management access is required.</p>
        ) : (
          <DestinationForm
            {...scope}
            {...(form ?? { mode: "create" as const })}
            onSaved={() => {
              if (task.active) task.setOpen(false);
              else {
                setForm(null);
                void load();
              }
            }}
          />
        )}
      </StreamingTaskPage>
    );

  return (
    <section className="space-y-5" aria-label="Stream destinations">
      <StreamingHeader
        title="Broadcast destinations"
        description="Send your stream to multiple platforms from one broadcast."
        actions={
          canManage && (
            <Button onClick={() => task.setOpen(true)}>
              <Plus />
              Add destination
            </Button>
          )
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { name: "YouTube", icon: Video, color: "text-red-500" },
          { name: "Twitch", icon: Gamepad2, color: "text-violet-500" },
          { name: "Facebook Live", icon: Radio, color: "text-blue-500" },
          { name: "Custom RTMP", icon: Link2, color: "text-foreground" },
        ].map(({ name, icon: Icon, color }) => (
          <div
            key={name}
            className="flex flex-col items-start rounded-xl border border-border/70 bg-card/30 p-4"
          >
            <Icon className={`mb-3 size-6 ${color}`} />
            <h3 className="text-sm font-semibold">{name}</h3>
            <p className="mb-4 mt-1 text-xs leading-relaxed text-muted-foreground">
              {name === "Custom RTMP"
                ? "Use any RTMP server."
                : "Use your platform's streaming credentials."}
            </p>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="mt-auto w-full rounded-lg"
                onClick={() => setForm({ mode: "create", suggestedName: name })}
              >
                Add destination
              </Button>
            )}
          </div>
        ))}
      </div>
      <StreamToolbar>
        <span className="mr-auto text-sm font-medium">
          Saved destinations{" "}
          <span className="ml-1 text-xs text-muted-foreground">({rows.length})</span>
        </span>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void load()}>
          <RefreshCw />
          Refresh
        </Button>
      </StreamToolbar>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!rows.length && (
        <StreamEmptyState
          title={pending ? "Loading destinations" : "No destinations yet"}
          description="Add a platform's server URL and stream key, then select it when creating a broadcast."
          icon={Link2}
        />
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-card/30 p-4 text-sm"
        >
          <div className="min-w-0 space-y-2">
            <p className="font-medium">
              {row.name} <Badge variant="outline">{row.enabled ? "Enabled" : "Disabled"}</Badge>
            </p>
            <p className="break-all">
              {row.protocol}://{row.host}:{row.port} · {row.profile}
            </p>
            <p className="text-xs text-muted-foreground">
              Stream key saved securely / Quality: {row.profile}
            </p>
            <p className="break-all font-mono text-[10px] text-muted-foreground">{row.id}</p>
          </div>
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Actions for ${row.name}`}
                className="inline-grid size-8 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5">
                <DropdownMenuItem disabled={pending} onClick={() => setForm({ mode: "edit", row })}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={pending}
                  onClick={() => {
                    setPending(true);
                    void updateDestinationAction({
                      ...scope,
                      destinationId: row.id,
                      idempotencyKey: crypto.randomUUID(),
                      configuration: { version: row.version, enabled: !row.enabled },
                    })
                      .then((result) => {
                        if (result.error) setError(result.error.description);
                        else void load();
                      })
                      .catch(() =>
                        setError("The destination could not be updated. Refresh before retrying."),
                      )
                      .finally(() => setPending(false));
                  }}
                >
                  {row.enabled ? "Disable" : "Enable"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={pending}
                  onClick={() => setForm({ mode: "rotate", row })}
                >
                  Replace key
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={pending}
                  onClick={() => {
                    removeKey.current = crypto.randomUUID();
                    setRemoving(row);
                  }}
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Changes apply to new broadcasts. Stop an active broadcast to disconnect its current
        destinations.
      </p>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              New broadcasts will no longer offer this destination. Existing broadcasts continue
              with their saved connection until you stop them. Output history remains available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (!removing) return;
                setPending(true);
                void deleteDestinationAction({
                  ...scope,
                  destinationId: removing.id,
                  idempotencyKey: removeKey.current,
                })
                  .then((result) => {
                    if (result.error) setError(result.error.description);
                    else {
                      setRemoving(null);
                      void load();
                    }
                  })
                  .catch(() => setError("Removal failed. Please retry."))
                  .finally(() => setPending(false));
              }}
            >
              Remove destination
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
function DestinationForm({
  mode,
  row,
  suggestedName,
  onSaved,
  ...scope
}: Scope & {
  mode: "create" | "edit" | "rotate";
  row?: ConsoleDestination;
  suggestedName?: string;
  onSaved: () => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState(row?.profile ?? "remux");
  const key = useRef<string | null>(null),
    busy = useRef(false);
  return (
    <form
      className="space-y-4 p-4"
      onChange={() => {
        key.current = null;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current) return;
        const data = new FormData(event.currentTarget);
        key.current ??= crypto.randomUUID();
        busy.current = true;
        setPending(true);
        setError(null);
        const base = { ...scope, idempotencyKey: key.current };
        const configuration = {
          name: String(data.get("name")),
          profile,
          ...(data.get("endpoint") ? { endpoint: String(data.get("endpoint")) } : {}),
        };
        const request =
          mode === "create"
            ? createDestinationAction({
                ...base,
                configuration: { ...configuration, streamKey: String(data.get("streamKey")) },
              })
            : mode === "rotate"
              ? rotateDestinationSecretAction({
                  ...base,
                  destinationId: row?.id,
                  configuration: {
                    version: row?.version,
                    streamKey: String(data.get("streamKey")),
                  },
                })
              : updateDestinationAction({
                  ...base,
                  destinationId: row?.id,
                  configuration: { ...configuration, version: row?.version },
                });
        void request
          .then((result) => {
            if (result.error) setError(result.error.description);
            else onSaved();
          })
          .catch(() =>
            setError("The destination could not be saved. Retry the same configuration."),
          )
          .finally(() => {
            busy.current = false;
            setPending(false);
          });
      }}
    >
      <fieldset disabled={pending} className="space-y-4">
        {mode !== "rotate" && (
          <>
            <div className="space-y-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="destination-name">Name</Label>
                <Input
                  id="destination-name"
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={row?.name ?? suggestedName ?? ""}
                  placeholder="YouTube"
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="destination-endpoint">
                  Server URL{mode === "edit" ? " (leave blank to keep)" : ""}
                </Label>
                <Input
                  id="destination-endpoint"
                  name="endpoint"
                  required={mode === "create"}
                  maxLength={512}
                  placeholder="rtmps://your-platform.example/live2"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="destination-profile">Output quality</Label>
              <SimpleSelect
                className="w-full sm:w-full"
                id="destination-profile"
                value={profile}
                onValueChange={(value) => {
                  setProfile(value as typeof profile);
                  key.current = null;
                }}
                options={[
                  { value: "remux", label: "Use stream quality (no extra encoding)" },
                  { value: "720p", label: "720p · 30 fps" },
                  { value: "1080p", label: "1080p · 30 fps" },
                ]}
              />
            </div>
          </>
        )}
        {mode !== "edit" && (
          <div className="space-y-2">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="destination-key">Stream key</Label>
              <Input
                id="destination-key"
                name="streamKey"
                type="password"
                required
                maxLength={1024}
                autoComplete="new-password"
              />
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The server URL must not include the stream key. Changes take effect in new broadcast runs.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save destination"}
        </Button>
      </fieldset>
    </form>
  );
}
