"use client";
import Link from "next/link";
import { GuestsManager } from "./guests-manager";
import { useStreamWorkspace } from "./stream-workspace";
export function StreamGuests() {
  const { projectId, environmentId, streamId, stream, broadcastId, broadcast, canManage, href } =
    useStreamWorkspace()!;
  if (stream.source.kind !== "room")
    return (
      <section className="space-y-3 rounded-xl border p-5">
        <h2 className="font-semibold">Guests need an RTC room source</h2>
        <p className="text-sm text-muted-foreground">
          Use a dedicated room with 2–4 seats to bring guests into the live stage.
        </p>
        <Link href={href("settings")} className="text-sm underline underline-offset-4">
          Configure the source
        </Link>
      </section>
    );
  if (!broadcastId)
    return (
      <section className="space-y-3 rounded-xl border p-5">
        <h2 className="font-semibold">Create a broadcast first</h2>
        <p className="text-sm text-muted-foreground">
          Invitations and guest permissions belong to a broadcast run.
        </p>
        <Link href={href("broadcasts")} className="text-sm underline underline-offset-4">
          Create a broadcast
        </Link>
      </section>
    );
  const accepting =
    !!broadcast &&
    broadcast.desiredState === "running" &&
    !["created", "stopping", "stopped", "failed"].includes(broadcast.state);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Use a dedicated RTC room with 2 to 4 total seats. Guests choose their own devices after
        accepting.
      </p>
      {!accepting && (
        <div className="space-y-2 rounded-xl border bg-muted/20 p-4">
          <p className="text-sm">
            This broadcast is not accepting guests. Start a broadcast before sending invitations;
            ended runs keep their history.
          </p>
          <Link className="text-sm underline underline-offset-4" href={href()}>
            Open overview
          </Link>
        </div>
      )}
      <GuestsManager
        projectId={projectId}
        environmentId={environmentId}
        streamId={streamId}
        broadcastId={broadcastId}
        canManage={canManage && accepting}
      />
    </div>
  );
}
