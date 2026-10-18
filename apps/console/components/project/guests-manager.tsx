"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { StreamGuestClient, type StreamGuestOptions } from "@relayrtc/client";
import type { GuestStage } from "@relayrtc/types";
import { guestCommandAction, guestListAction, guestStageAction } from "@/actions/guests";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { SimpleSelect } from "@/components/page/simple-select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
export function GuestsManager({
  projectId,
  environmentId,
  streamId,
  broadcastId,
  canManage,
}: {
  projectId: string;
  environmentId: string;
  streamId: string;
  broadcastId: string;
  canManage: boolean;
}) {
  const scope = useMemo(
    () => ({ projectId, environmentId, streamId, broadcastId }),
    [projectId, environmentId, streamId, broadcastId],
  );
  const [moderating, setModerating] = useState<{
    action: "mute" | "remove";
    guestId: string;
    version: number;
    name: string;
    audio?: boolean;
  } | null>(null);
  const [stage, setStage] = useState<GuestStage | null>(null),
    [error, setError] = useState(""),
    [inviteOpen, setInviteOpen] = useState(false),
    [pending, setPending] = useState(false),
    [older, setOlder] = useState<string | undefined>();
  const [collection, setCollection] = useState<"guests" | "invites" | "guest-requests">("guests");
  const getStatus = useCallback<StreamGuestOptions["getStatus"]>(
    async (signal) => {
      const settings = await guestStageAction(scope);
      signal.throwIfAborted();
      if (settings.error) throw new Error("Stage unavailable");
      setStage(settings.data);
      if (settings.data.version === 0) return { data: [], nextCursor: null, stage: settings.data };
      const result = await guestListAction({
        ...scope,
        collection,
        ...(older ? { cursor: older } : {}),
      });
      signal.throwIfAborted();
      if (result.error) throw new Error("Guest roster unavailable");
      return result.data;
    },
    [scope, older, collection],
  );
  const command = useCallback<StreamGuestOptions["command"]>(
    async (action, input, context) => {
      const configuration =
        action === "invite"
          ? { recipientSubject: input.recipientSubject, media: input.media }
          : {
              version: input.version,
              ...(action === "mute" ? { audio: input.audio, video: input.video } : {}),
            };
      const result = await guestCommandAction({
        ...scope,
        action,
        ...(input.guestId ? { guestId: input.guestId } : {}),
        configuration,
        idempotencyKey: context.idempotencyKey,
      });
      context.signal.throwIfAborted();
      if (result.error) throw new Error(result.error.description);
      return result.data;
    },
    [scope],
  );
  const client = useMemo(() => new StreamGuestClient({ getStatus, command }), [getStatus, command]);
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getServerSnapshot,
  );
  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);
  const configure = async (
    enabled: boolean,
    maxGuests: number,
    layout: "grid" | "single" | "pip",
  ) => {
    if (!stage) return;
    setPending(true);
    setError("");
    try {
      const result = await guestStageAction({
        ...scope,
        configuration: { enabled, maxGuests, layout, version: stage.version },
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.error) setError(result.error.description);
      else {
        setStage(result.data);
        await client.refresh();
      }
    } catch {
      setError("Guest stage could not be saved. Reload and try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Live guests">
      <h3 className="font-medium">Live guests</h3>
      <p className="text-sm text-muted-foreground">
        A dedicated RTC room supports a host and up to three guests. Entering stage mode may briefly
        reconnect the program; subsequent guest changes keep the encoder running.
      </p>
      <p role="status">
        {stage?.enabled ? "Stage enabled" : "Stage disabled"} · {stage?.occupied ?? 0}/
        {stage?.maxGuests ?? 3} guest slots reserved
      </p>
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void configure(
              data.get("enabled") === "on",
              Number(data.get("maxGuests")),
              data.get("layout") as "grid" | "single" | "pip",
            );
          }}
        >
          <Label>
            <Switch
              value="on"
              name="enabled"
              defaultChecked={stage?.enabled}
              key={`enabled-${stage?.version}`}
            />{" "}
            Enable stage
          </Label>
          <Label className="grid gap-2">
            Guest slots
            <Input
              name="maxGuests"
              type="number"
              min={1}
              max={3}
              defaultValue={stage?.maxGuests ?? 3}
              key={`slots-${stage?.version}`}
            />
          </Label>
          <Label className="grid gap-2">
            Layout
            <SimpleSelect
              name="layout"
              defaultValue={stage?.layout ?? "grid"}
              key={`layout-${stage?.version}`}
              aria-label="Stage layout"
              options={[
                { value: "grid", label: "Grid" },
                { value: "single", label: "Single speaker" },
                { value: "pip", label: "Picture in picture (one guest)" },
              ]}
            />
          </Label>
          <Button type="submit" disabled={pending || !stage}>
            Save stage
          </Button>
          <Button type="button" disabled={!stage?.enabled} onClick={() => setInviteOpen(true)}>
            Invite guest
          </Button>
        </form>
      )}
      {(error || snapshot.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || snapshot.error?.message}
        </p>
      )}
      <Tabs
        value={collection}
        onValueChange={(value) => {
          if (value !== "guests" && value !== "invites" && value !== "guest-requests") return;
          setOlder(undefined);
          setCollection(value);
        }}
      >
        <TabsList aria-label="Guest views">
          <TabsTrigger value="guests">Roster</TabsTrigger>
          <TabsTrigger value="guest-requests">Requests</TabsTrigger>
          <TabsTrigger value="invites">Invitations</TabsTrigger>
        </TabsList>
        <TabsContent key={collection} value={collection} className="space-y-3 pt-2">
          {snapshot.roster && !snapshot.roster.data.length && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {collection === "guests"
                ? "No guests on stage yet. Invite someone or approve a request."
                : collection === "invites"
                  ? "No invitations in this view."
                  : "No guest requests in this view."}
            </p>
          )}
          {snapshot.roster?.data.map((g) => (
            <div key={g.id} className="space-y-2 rounded border p-3">
              <p>
                {g.name} · {g.kind} · {g.state} · version {g.version}
              </p>
              <p className="text-sm">
                {g.subject ?? ""} · Expires {g.expiresAt} · Audio{" "}
                {g.media.audio ? (g.mutedAudio ? "moderator muted" : "permitted") : "not permitted"}
                ; video{" "}
                {g.media.video ? (g.mutedVideo ? "moderator muted" : "permitted") : "not permitted"}
              </p>
              {canManage &&
                g.state === "pending" &&
                (g.kind === "request" ? (
                  <>
                    <Button
                      disabled={!!snapshot.pending}
                      onClick={() =>
                        void client.command("approveRequest", { guestId: g.id, version: g.version })
                      }
                    >
                      Approve
                    </Button>{" "}
                    <Button
                      disabled={!!snapshot.pending}
                      onClick={() =>
                        void client.command("rejectRequest", { guestId: g.id, version: g.version })
                      }
                    >
                      Reject
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={!!snapshot.pending}
                    onClick={() =>
                      void client.command("cancelInvite", { guestId: g.id, version: g.version })
                    }
                  >
                    Cancel invitation
                  </Button>
                ))}
              {canManage && ["accepted", "approved", "joined"].includes(g.state) && (
                <>
                  <Button
                    disabled={!!snapshot.pending}
                    onClick={() =>
                      setModerating({
                        action: "mute",
                        guestId: g.id,
                        version: g.version,
                        name: g.name,
                        audio: !g.mutedAudio,
                      })
                    }
                  >
                    {g.mutedAudio ? "Allow microphone" : "Mute microphone"}
                  </Button>{" "}
                  <Button
                    variant="destructive"
                    disabled={!!snapshot.pending}
                    onClick={() =>
                      setModerating({
                        action: "remove",
                        guestId: g.id,
                        version: g.version,
                        name: g.name,
                      })
                    }
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
          ))}
          {snapshot.roster?.nextCursor && (
            <Button onClick={() => setOlder(snapshot.roster?.nextCursor ?? undefined)}>
              Older guests
            </Button>
          )}
          {older && <Button onClick={() => setOlder(undefined)}>Latest guests</Button>}
        </TabsContent>
      </Tabs>
      <AlertDialog
        open={moderating !== null}
        onOpenChange={(open) => {
          if (!open && !snapshot.pending) setModerating(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {moderating?.action === "remove"
                ? `Remove ${moderating.name}?`
                : `Change ${moderating?.name}'s microphone permission?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {moderating?.action === "remove"
                ? "Their stage connection closes and active credentials are revoked."
                : "Their current stage connection closes. They must rejoin with the new permission and choose their own devices. This never turns on their microphone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {snapshot.error && (
            <p role="alert" className="text-sm text-destructive">
              {snapshot.error.message}
            </p>
          )}
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={!!snapshot.pending}
              onClick={() => setModerating(null)}
            >
              Cancel
            </Button>
            <Button
              variant={moderating?.action === "remove" ? "destructive" : "default"}
              disabled={!!snapshot.pending}
              onClick={() => {
                if (!moderating) return;
                void client
                  .command(moderating.action, {
                    guestId: moderating.guestId,
                    version: moderating.version,
                    ...(moderating.audio === undefined ? {} : { audio: moderating.audio }),
                  })
                  .then((result) => {
                    if (result) setModerating(null);
                  });
              }}
            >
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a guest</DialogTitle>
            <DialogDescription>
              Use the application subject bound by your backend. The invited viewer must accept and
              choose their own devices.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void client
                .command("invite", {
                  recipientSubject: String(data.get("subject")),
                  media: {
                    audio: data.get("audio") === "on",
                    video: data.get("video") === "on",
                    screen: data.get("screen") === "on",
                  },
                })
                .then((result) => {
                  if (result) {
                    setInviteOpen(false);
                    setOlder(undefined);
                    setCollection("invites");
                  }
                });
            }}
          >
            <Label className="grid gap-2">
              Application subject
              <Input name="subject" required maxLength={128} />
            </Label>
            <Label className="block">
              <Checkbox value="on" name="audio" defaultChecked /> Audio
            </Label>
            <Label className="block">
              <Checkbox value="on" name="video" /> Camera
            </Label>
            <Label className="block">
              <Checkbox value="on" name="screen" /> Screen sharing
            </Label>
            <Button type="submit" disabled={!!snapshot.pending}>
              Send invitation
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
