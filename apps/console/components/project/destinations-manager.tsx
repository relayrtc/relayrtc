"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import {
  listDestinationsAction,
  createDestinationAction,
  updateDestinationAction,
  rotateDestinationSecretAction,
  deleteDestinationAction,
} from "@/actions/destinations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/page/simple-select";
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
import type { ConsoleDestination } from "@/lib/streaming/destination-contracts";
type Scope = { projectId: string; environmentId: string; streamId: string };
export function DestinationsManager({
  canManage,
  projectId,
  environmentId,
  streamId,
}: Scope & { canManage: boolean }) {
  const scope = { projectId, environmentId, streamId };
  const [rows, setRows] = useState<ConsoleDestination[]>([]),
    [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false),
    [form, setForm] = useState<{
      mode: "create" | "edit" | "rotate";
      row?: ConsoleDestination;
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
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Stream destinations">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Destinations</h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              void load();
            }}
          >
            <RefreshCw />
            Refresh
          </Button>
          {canManage && (
            <Button size="sm" disabled={pending} onClick={() => setForm({ mode: "create" })}>
              <Plus />
              Add destination
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Send your video to YouTube, Twitch or another streaming platform using its server URL and
        stream key. Destinations are optional for private playback, recordings and clips. Changes
        apply to new broadcasts; stop an existing run to disconnect its saved outputs.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!rows.length && (
        <p className="text-sm text-muted-foreground">
          {pending
            ? "Loading destinations..."
            : "No destinations yet. Add a platform server URL and stream key, then select it when creating a broadcast."}
        </p>
      )}
      {rows.map((row) => (
        <div key={row.id} className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">
            {row.name} <Badge variant="outline">{row.enabled ? "Enabled" : "Disabled"}</Badge>
          </p>
          <p className="break-all">
            {row.protocol}://{row.host}:{row.port} · {row.profile}
          </p>
          <p className="text-xs text-muted-foreground">
            Stream key: •••••••• · credential version {row.credentialVersion}
          </p>
          <p className="break-all font-mono text-xs">{row.id}</p>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setForm({ mode: "edit", row })}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
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
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setForm({ mode: "rotate", row })}
              >
                Replace key
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  removeKey.current = crypto.randomUUID();
                  setRemoving(row);
                }}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      ))}
      <Sheet
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {form?.mode === "create"
                ? "Add destination"
                : form?.mode === "rotate"
                  ? "Replace stream key"
                  : "Edit destination"}
            </SheetTitle>
            <SheetDescription>
              Use the server URL and key supplied by your streaming platform. Stored URLs and keys
              are private.
            </SheetDescription>
          </SheetHeader>
          {form && (
            <DestinationForm
              key={`${form.mode}:${form.row?.id ?? "new"}`}
              {...scope}
              {...form}
              onSaved={() => {
                setForm(null);
                void load();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
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
              New runs will no longer offer this destination. Existing runs continue with their
              saved connection until you stop them. Output history remains available.
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
  onSaved,
  ...scope
}: Scope & { mode: "create" | "edit" | "rotate"; row?: ConsoleDestination; onSaved: () => void }) {
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
              <Label htmlFor="destination-name">Name</Label>
              <Input
                id="destination-name"
                name="name"
                required
                maxLength={120}
                defaultValue={row?.name ?? ""}
                placeholder="YouTube"
              />
            </div>
            <div className="space-y-2">
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
            <Label htmlFor="destination-profile">Output quality</Label>
            <SimpleSelect
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
          </>
        )}
        {mode !== "edit" && (
          <div className="space-y-2">
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
