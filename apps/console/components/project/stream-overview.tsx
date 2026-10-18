"use client";
import { StreamSectionCard } from "./stream-section-card";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  commandStreamAction,
  createIngestCredentialAction,
  getStreamingOperationAction,
  getStreamUsageAction,
} from "@/actions/streaming";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/page/copy-button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import type { ConsoleIngestCredential, ConsoleStreamingOperation } from "@/lib/streaming/contracts";
import { useStreamWorkspace } from "./stream-workspace";
import { StreamPreview } from "./stream-preview";
import { BroadcastDetails } from "./broadcasts-manager";

export function StreamOverview() {
  const workspace = useStreamWorkspace()!;
  const { projectId, environmentId, streamId, stream, broadcast, canManage, href } = workspace;
  const router = useRouter();
  const [credential, setCredential] = useState<ConsoleIngestCredential | null>(null),
    [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<ConsoleStreamingOperation | null>(null);
  const [confirm, setConfirm] = useState<"stop" | "rotate" | null>(null);
  const [usage, setUsage] = useState<{
    sourceSeconds: number;
    ingressBytes: number;
    programBytes: number;
    coverage: string;
  } | null>(null);
  const keys = useRef(new Map<string, string>()),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = (action: string) => {
    const existing = keys.current.get(action) ?? crypto.randomUUID();
    keys.current.set(action, existing);
    return existing;
  };
  useEffect(() => {
    let active = true,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await getStreamUsageAction({ projectId, environmentId, streamId });
        if (active && result.data) setUsage(result.data);
      } finally {
        busy = false;
      }
    };
    void load().catch(() => undefined);
    const timer = setInterval(() => void load().catch(() => undefined), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, environmentId, streamId]);
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
            if (result.data.status !== "pending") router.refresh();
          }
        })
        .catch(() => {
          if (active) setError("Operation status is unavailable. Refresh to retry.");
        })
        .finally(() => {
          busy = false;
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, environmentId, operationId, operationStatus, router]);
  const execute = async (action: "start" | "stop" | "credential" | "rotate") => {
    setPending(true);
    setError(null);
    try {
      if (action === "credential" || action === "rotate") {
        const result = await createIngestCredentialAction({
          projectId,
          environmentId,
          streamId,
          idempotencyKey: key(action),
          ...(action === "rotate" && credential ? { credentialId: credential.id } : {}),
        });
        if (!alive.current) return;
        if (result.error) setError(result.error.description);
        else {
          keys.current.delete(action);
          setCredential(result.data);
          setReveal(false);
          setConfirm(null);
        }
      } else {
        const result = await commandStreamAction({
          projectId,
          environmentId,
          streamId,
          command: action,
          idempotencyKey: key(action),
        });
        if (!alive.current) return;
        if (result.error) setError(result.error.description);
        else {
          keys.current.delete(action);
          setOperation(result.data);
          setConfirm(null);
          router.refresh();
        }
      }
    } catch {
      if (alive.current) setError("The action could not be completed. Retry to check its result.");
    } finally {
      if (alive.current) setPending(false);
    }
  };
  const session =
    stream.sessions.find((s) => ["live", "starting", "reconnecting"].includes(s.state)) ??
    stream.sessions[0];
  const sourceActive = !!session && ["live", "starting", "reconnecting"].includes(session.state);
  const status =
    stream.status !== "active"
      ? "This stream has been retired."
      : session?.state === "live"
        ? "Your source is live."
        : session?.state === "starting"
          ? "Waiting for source video or audio."
          : session?.state === "reconnecting"
            ? "Reconnecting to your source."
            : session?.state === "failed"
              ? "The source stopped unexpectedly. Check its health below."
              : stream.source.kind === "room"
                ? "Join the RTC room and publish, then start the source."
                : "Connect your encoder to start sending video or audio.";
  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-muted/20 p-5">
        <div className="space-y-1">
          <h2 className="font-semibold">{status}</h2>
          <p className="text-sm text-muted-foreground">
            {!broadcast
              ? "After connecting the source, create a broadcast to manage outputs and guests."
              : ["stopped", "failed"].includes(broadcast.state)
                ? "This broadcast has ended. Create a new one for your next session."
                : "Manage your broadcast below, or open a section in the sidebar."}
          </p>
        </div>
        <Link
          href={href("broadcasts")}
          className="text-sm font-medium underline underline-offset-4"
        >
          {!broadcast || ["stopped", "failed"].includes(broadcast.state)
            ? "Create a broadcast"
            : "Broadcast history"}
        </Link>
      </section>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)]">
        <StreamSectionCard title="Live preview" className="min-w-0">
          <StreamPreview projectId={projectId} environmentId={environmentId} streamId={streamId} />
        </StreamSectionCard>
        <StreamSectionCard
          title={stream.source.kind === "room" ? "RTC source" : "Encoder setup"}
          className="min-w-0"
        >
          {stream.source.kind === "room" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Connect your application to this room using the SDK and publish audio or video.
              </p>
              <div className="flex items-center gap-2 break-all text-sm">
                <span>{stream.source.roomId}</span>
                <CopyButton value={stream.source.roomId} />
              </div>
              {canManage && (
                <Button
                  disabled={pending || sourceActive || stream.status !== "active"}
                  onClick={() => void execute("start")}
                >
                  Start source
                </Button>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {stream.source.kind === "rtmp"
                  ? "Use a custom streaming server in OBS or Streamlabs."
                  : "Use a WHIP-compatible encoder or client."}{" "}
                Credentials are shown only when issued.
              </p>
              {canManage && (
                <Button
                  disabled={pending || stream.status !== "active"}
                  onClick={() => (credential ? setConfirm("rotate") : void execute("credential"))}
                >
                  {credential ? "Rotate encoder credential" : "Generate encoder credential"}
                </Button>
              )}
              {credential && (
                <div className="space-y-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(credential.expiresAt).toLocaleString()}. Save the secret
                    before leaving this page.
                  </p>
                  <div>
                    <p className="font-medium">Server URL</p>
                    <div className="flex items-start gap-2">
                      <code className="min-w-0 break-all">{credential.url}</code>
                      <CopyButton value={credential.url} />
                    </div>
                  </div>
                  {credential.protocol === "rtmp" && (
                    <p>
                      Authentication username: <code>publisher</code>
                      <CopyButton value="publisher" />
                    </p>
                  )}
                  <div>
                    <p className="font-medium">
                      {credential.protocol === "rtmp" ? "Authentication password" : "Bearer token"}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="break-all">
                        {reveal ? credential.secret : "••••••••••••••••"}
                      </code>
                      <CopyButton value={credential.secret} />
                      <Button size="sm" variant="ghost" onClick={() => setReveal(!reveal)}>
                        {reveal ? "Hide" : "Reveal"}
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {credential.protocol === "rtmp"
                      ? "Enable authentication. Use the complete server URL and leave the stream key blank when supported."
                      : "Send the bearer token to the WHIP server URL."}
                  </p>
                </div>
              )}
            </>
          )}
          {canManage && sourceActive && (
            <Button variant="outline" disabled={pending} onClick={() => setConfirm("stop")}>
              Stop source
            </Button>
          )}
        </StreamSectionCard>
      </div>
      {operation && (
        <p role="status" className="text-sm">
          Source action: {operation.status}
          {operation.errorCode ? ` · ${operation.errorCode}` : ""}
        </p>
      )}
      <StreamSectionCard title="Selected broadcast" className="min-w-0">
        {broadcast ? (
          <BroadcastDetails
            key={broadcast.id}
            projectId={projectId}
            environmentId={environmentId}
            broadcastId={broadcast.id}
            canManage={canManage}
            compact
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No broadcasts yet. Create one to choose destinations and start a run.
          </p>
        )}
      </StreamSectionCard>
      <Accordion className="rounded-xl border p-5">
        <AccordionItem value="section-1">
          <AccordionTrigger>Source health and usage</AccordionTrigger>
          <AccordionContent className="space-y-4 pt-2">
            <div className="mt-4 space-y-3 text-sm">
              {usage && (
                <p>
                  {Math.round(usage.sourceSeconds)} source seconds ·{" "}
                  {(usage.ingressBytes / 1048576).toFixed(1)} MiB received ·{" "}
                  {(usage.programBytes / 1048576).toFixed(1)} MiB program output · {usage.coverage}{" "}
                  coverage
                </p>
              )}
              {stream.sessions.map((s) => (
                <div key={s.id} className="space-y-1">
                  <Badge variant="outline">{s.state}</Badge>
                  <p>
                    Attempt {s.attempts} · Ingress {Math.round(s.ingressBitrate / 1000)} kbit/s ·
                    Program {Math.round(s.programBitrate / 1000)} kbit/s
                  </p>
                  {s.lastError && (
                    <p role="status" className="text-destructive">
                      {s.lastError}
                    </p>
                  )}
                </div>
              ))}
              {!stream.sessions.length && <p>No source session has started yet.</p>}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "rotate" ? "Rotate this encoder credential?" : "Stop the source?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "rotate"
                ? "The previous credential will stop working and its publisher will disconnect. Update your encoder with the replacement."
                : "Live playback and connected outputs can be interrupted. The RTC room remains available."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => confirm && void execute(confirm)}
            >
              {pending ? "Working…" : "Confirm"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
