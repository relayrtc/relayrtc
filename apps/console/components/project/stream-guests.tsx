"use client";
import { StreamingHeader, StreamEmptyState } from "./stream-ui";
import { buttonVariants } from "@/components/ui/button";
import { Users } from "lucide-react";
import Link from "next/link";
import { GuestsManager } from "./guests-manager";
import { useStreamWorkspace } from "./stream-workspace";
export function StreamGuests() {
  const { projectId, environmentId, streamId, stream, broadcastId, broadcast, canManage, href } =
    useStreamWorkspace()!;
  if (stream.source.kind !== "room")
    return (
      <div className="space-y-5">
        <StreamingHeader title="Guests" description="Invite people to join your live broadcast." />
        <StreamEmptyState
          icon={Users}
          title="Bring guests on stage"
          description="Guests need a WebRTC room source with 2 to 4 seats. Configure a room source to enable invitations and guest controls."
          actions={
            <Link href={href("settings")} className={buttonVariants({ size: "sm" })}>
              Configure source
            </Link>
          }
        />
      </div>
    );
  if (!broadcastId)
    return (
      <div className="space-y-5">
        <StreamingHeader
          title="Guests"
          description="Manage invitations, requests and the people on stage."
        />
        <StreamEmptyState
          icon={Users}
          title="Create a broadcast first"
          description="Guest invitations and permissions belong to a broadcast. Create one to get your stage ready."
          actions={
            canManage && (
              <Link href={href("broadcasts/new")} className={buttonVariants({ size: "sm" })}>
                Create broadcast
              </Link>
            )
          }
        />
      </div>
    );
  const accepting =
    !!broadcast &&
    broadcast.desiredState === "running" &&
    !["created", "stopping", "stopped", "failed"].includes(broadcast.state);
  return (
    <div className="space-y-5">
      <StreamingHeader
        title="Guests"
        description="Manage your stage, invitations and guest requests."
      />

      {!accepting && (
        <div className="space-y-2 rounded-xl border bg-muted/20 p-4">
          <p className="text-sm">
            This broadcast is not accepting guests. Start a broadcast before sending invitations;
            ended broadcasts keep their history.
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
