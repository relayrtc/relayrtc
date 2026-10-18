"use client";
import { StreamSectionCard } from "./stream-section-card";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { commandStreamAction } from "@/actions/streaming";
import { StreamForm } from "./stream-form";
import { DvrManager } from "./dvr-manager";
import { useStreamWorkspace } from "./stream-workspace";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
export function StreamSettings() {
  const { projectId, environmentId, streamId, stream, canManage, href } = useStreamWorkspace()!;
  const router = useRouter(),
    key = useRef(crypto.randomUUID());
  const [confirm, setConfirm] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const remove = async () => {
    setPending(true);
    try {
      const result = await commandStreamAction({
        projectId,
        environmentId,
        streamId,
        command: "delete",
        idempotencyKey: key.current,
      });
      if (result.error) setError(result.error.description);
      else
        router.replace(
          href().split("/streams/")[0] +
            `/streams?environmentId=${encodeURIComponent(environmentId)}`,
        );
    } catch {
      setError("Could not retire the stream. Retry to check its result.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StreamSectionCard
        title="Stream settings"
        description={<>Source and encoding changes apply to new source sessions and broadcasts.</>}
      >
        {canManage && stream.status === "active" ? (
          <StreamForm
            key={stream.version}
            projectId={projectId}
            environmentId={environmentId}
            stream={stream}
            onSaved={() => router.refresh()}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {stream.status !== "active"
              ? "This stream has been retired and can no longer be edited."
              : "You need project management access to edit this stream."}
          </p>
        )}
      </StreamSectionCard>
      <DvrManager
        projectId={projectId}
        environmentId={environmentId}
        streamId={streamId}
        canManage={canManage}
      />
      {canManage && stream.status === "active" && (
        <StreamSectionCard
          title="Retire stream"
          description={
            <>
              Revoke credentials, stop streaming and remove retained private media. Historical audit
              and usage remain.
            </>
          }
          className="border border-destructive/20"
        >
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            Retire stream
          </Button>
        </StreamSectionCard>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!pending) setConfirm(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {stream.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops streaming, revokes credentials and removes retained private media. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => void remove()}>
              {pending ? "Retiring…" : "Retire stream"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
