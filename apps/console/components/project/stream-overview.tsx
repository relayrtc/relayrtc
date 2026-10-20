"use client";
import {
  Radio,
  Settings2,
  Waypoints,
  Users,
  Scissors,
  ArrowUpRight,
  Activity,
  Monitor,
  Gauge,
  Clock3,
  Download,
  Upload,
  AudioLines,
  Video,
  ChevronRight,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { rtmpEncoderFields } from "@/lib/streaming/setup";
import { BroadcastPreparation } from "./broadcast-preparation";
import { SimpleSelect } from "@/components/page/simple-select";
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
  getStreamUsageReportAction,
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
import { ServiceUsagePanel } from "./service-usage-panel";
import type { ServiceUsageReport } from "@relayrtc/validation";
import type { StreamPlaybackReadiness } from "@relayrtc/types";

export function StreamOverview() {
  const workspace = useStreamWorkspace()!;
  const { projectId, environmentId, streamId, stream, broadcast, canManage, href } = workspace;
  const router = useRouter();
  const [encoder, setEncoder] = useState("streamlabs");
  const [readiness, setReadiness] = useState<StreamPlaybackReadiness | null>(null);
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
  const [usageReport, setUsageReport] = useState<ServiceUsageReport>();
  const [usageRange, setUsageRange] = useState<"24h" | "7d" | "30d">("24h");
  const [usageError, setUsageError] = useState<string | null>(null);
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
        const [result, report] = await Promise.all([
          getStreamUsageAction({ projectId, environmentId, streamId }),
          getStreamUsageReportAction({ projectId, environmentId, streamId, range: usageRange }),
        ]);
        if (active && result.data) setUsage(result.data);
        if (active) {
          setUsageError(report.error?.description ?? null);
          if (report.data) setUsageReport(report.data);
        }
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
  }, [projectId, environmentId, streamId, usageRange]);
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
        ? readiness?.viewerReady
          ? "Your source is sending media and playback is ready."
          : "Your source is sending media. Playback is preparing."
        : session?.state === "starting"
          ? "Waiting for source video or audio."
          : session?.state === "reconnecting"
            ? "Reconnecting to your source."
            : session?.state === "failed"
              ? "The source stopped unexpectedly. Check its health below."
              : stream.source.kind === "room"
                ? "Join the RTC room and publish, then start the source."
                : "Connect your encoder to start sending video or audio.";
  const sourceLive = session?.state === "live";
  const sourceLabel =
    stream.status !== "active"
      ? "Retired"
      : sourceLive
        ? "Connected"
        : session?.state === "starting"
          ? "Connecting"
          : session?.state === "reconnecting"
            ? "Reconnecting"
            : session?.state === "failed"
              ? "Connection failed"
              : "Not connected";
  const sourceName =
    stream.source.kind === "room" ? "WebRTC room" : stream.source.kind.toUpperCase();
  const outputResolution = stream.profile.audioOnly
    ? "Audio only"
    : `${stream.profile.width} x ${stream.profile.height}`;
  const connectionRows = [
    { label: "Source", value: sourceLabel, icon: Radio },
    {
      label: "Viewer playback",
      value: readiness?.viewerReady
        ? "Ready"
        : readiness?.status === "failed"
          ? "Failed"
          : readiness?.sourceProducing
            ? "Preparing"
            : "Waiting for media",
      icon: Monitor,
    },
    { label: "Source type", value: sourceName, icon: Video },
    { label: "Output resolution", value: outputResolution, icon: Monitor },
    {
      label: "Target frame rate",
      value: stream.profile.audioOnly ? "Audio only" : `${stream.profile.fps} FPS`,
      icon: Activity,
    },
    {
      label: "Incoming bitrate",
      value: sourceActive ? `${(session.ingressBitrate / 1000000).toFixed(2)} Mbit/s` : "--",
      icon: Gauge,
    },
    {
      label: "Broadcast",
      value: broadcast?.state.replaceAll("_", " ") ?? "Not started",
      icon: Radio,
    },
  ];
  const quickActions = [
    {
      label: "Edit settings",
      detail: "Update stream details",
      section: "settings",
      icon: Settings2,
      color: "bg-muted text-muted-foreground",
    },
    {
      label: "Manage destinations",
      detail: "Add or remove platforms",
      section: "destinations",
      icon: Waypoints,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    },
    {
      label: "Invite guest",
      detail: "Bring someone on stage",
      section: "guests",
      icon: Users,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    },
    {
      label: "Create clip",
      detail: "Save a highlight",
      section: "clips/new",
      icon: Scissors,
      color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    },
  ];
  const healthMetrics = [
    {
      label: "Incoming bitrate",
      value: sourceActive ? `${(session.ingressBitrate / 1000000).toFixed(2)} Mbit/s` : "--",
      detail: sourceActive ? "From your source" : "Waiting for a source",
      icon: Download,
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Program bitrate",
      value: sourceActive ? `${(session.programBitrate / 1000000).toFixed(2)} Mbit/s` : "--",
      detail: "Encoded media output",
      icon: Upload,
      color: "text-blue-600 dark:text-blue-400",
    },
    {
      label: "Source time",
      value: usage ? `${Math.round(usage.sourceSeconds / 60).toLocaleString()} min` : "--",
      detail: "Lifetime observed source time",
      icon: Clock3,
      color: "text-violet-600 dark:text-violet-400",
    },
    {
      label: "Media received",
      value: usage ? `${(usage.ingressBytes / 1048576).toFixed(1)} MiB` : "--",
      detail: usage?.coverage === "partial" ? "Lifetime; partial measurement" : "Lifetime incoming media",
      icon: AudioLines,
      color: "text-amber-600 dark:text-amber-400",
    },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="grid items-stretch gap-4 md:grid-cols-[minmax(0,1.65fr)_minmax(15rem,1fr)]">
        <OverviewPanel
          title="Live preview"
          actions={
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  sourceLive ? "bg-emerald-500" : "bg-muted-foreground/50",
                )}
              />
              {sourceLive ? "Receiving media" : "Private preview"}
            </span>
          }
        >
          <StreamPreview
            projectId={projectId}
            environmentId={environmentId}
            streamId={streamId}
            onReadiness={setReadiness}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {sourceName} / {outputResolution}
            </span>
            <Link
              href={href("dvr")}
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              Playback settings
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </OverviewPanel>
        <OverviewPanel
          title="Stream status"
          actions={
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                sourceLive
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <span className="size-1 rounded-full bg-current" />
              {sourceLive ? "Connected" : sourceLabel}
            </span>
          }
        >
          <dl className="space-y-4">
            {connectionRows.map(({ label, value, icon: Icon }) => (
              <div key={label} className="flex items-center justify-between gap-3 text-xs">
                <dt className="flex items-center gap-2 text-muted-foreground">
                  <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
                  {label}
                </dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 border-t border-border/60 pt-3">
            <p className="text-xs leading-relaxed text-muted-foreground">{status}</p>
            {!sourceLive && stream.status === "active" && (
              <a
                href="#source-setup"
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium"
              >
                Source setup
                <ChevronRight className="size-3" />
              </a>
            )}
          </div>
        </OverviewPanel>
      </div>

      <section aria-labelledby="quick-actions-title">
        <h2 id="quick-actions-title" className="mb-3 text-sm font-semibold">
          Quick actions
        </h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {quickActions
            .filter((item) => canManage || item.section !== "clips/new")
            .map(({ label, detail, section, icon: Icon, color }) => (
              <Link
                key={section}
                href={href(section)}
                className="group flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/30 p-3 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", color)}>
                  <Icon className="size-4" strokeWidth={1.7} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">{label}</span>
                  <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">
                    {detail}
                  </span>
                </span>
              </Link>
            ))}
        </div>
      </section>

      <OverviewPanel
        title="Stream health"
        actions={<span className="text-[10px] text-muted-foreground">Updates automatically</span>}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {healthMetrics.map(({ label, value, detail, icon: Icon, color }) => (
            <div key={label} className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <Icon className={cn("size-3.5", color)} />
              </div>
              <p className="mt-2 text-lg font-semibold tracking-tight tabular-nums">{value}</p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{detail}</p>
            </div>
          ))}
        </div>
      </OverviewPanel>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,1fr)]">
        <OverviewPanel
          id="source-setup"
          title={stream.source.kind === "room" ? "Room connection" : "Encoder setup"}
          description="Connect your source to start sending audio and video."
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
                  {credential.handover && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {credential.handover.status === "pending"
                        ? "The old credential is revoked. Teardown was queued; reconnect with this replacement and retry after two seconds if needed."
                        : "The old publisher has been released. Configure this replacement credential and reconnect your encoder."}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(credential.expiresAt).toLocaleString()}. Save the secret
                    before leaving this page.
                  </p>
                  {credential.protocol === "rtmp" ? (
                    <>
                      <SimpleSelect
                        aria-label="Encoder setup"
                        value={encoder}
                        onValueChange={setEncoder}
                        options={[
                          { value: "streamlabs", label: "Streamlabs / server and stream key" },
                          { value: "auth", label: "Encoder with username and password" },
                        ]}
                      />
                      {encoder === "streamlabs" ? (
                        <>
                          <CredentialField
                            label="Server URL"
                            value={rtmpEncoderFields(credential.url, credential.secret).server}
                          />
                          <CredentialField
                            label="Stream key"
                            value={rtmpEncoderFields(credential.url, credential.secret).streamKey}
                            secret
                            reveal={reveal}
                          />
                          <p className="text-xs text-muted-foreground">
                            Choose Custom Streaming Server. Paste these two fields and leave Use
                            authentication off. Start streaming in your encoder to connect the
                            source.
                          </p>
                        </>
                      ) : (
                        <>
                          <CredentialField
                            label="Server URL (complete path)"
                            value={credential.url}
                          />
                          <CredentialField label="Username" value="publisher" />
                          <CredentialField
                            label="Password"
                            value={credential.secret}
                            secret
                            reveal={reveal}
                          />
                          <p className="text-xs text-muted-foreground">
                            Enable authentication and leave the stream key blank. If your encoder
                            requires a stream key, choose the server and stream key option above.
                          </p>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <CredentialField label="WHIP endpoint" value={credential.url} />
                      <CredentialField
                        label="Bearer token"
                        value={credential.secret}
                        secret
                        reveal={reveal}
                      />
                      <p className="text-xs text-muted-foreground">
                        Use a WHIP-compatible encoder. Send this token as bearer authentication to
                        the endpoint.
                      </p>
                    </>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setReveal(!reveal)}
                  >
                    {reveal ? "Hide credential" : "Reveal credential"}
                  </Button>
                </div>
              )}
            </>
          )}
          {canManage && sourceActive && (
            <Button variant="outline" disabled={pending} onClick={() => setConfirm("stop")}>
              Stop source
            </Button>
          )}

          {operation && (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              Source action: {operation.status}
              {operation.errorCode ? ` / ${operation.errorCode}` : ""}
            </p>
          )}
        </OverviewPanel>
        {canManage && (!broadcast || ["created", "stopped", "failed"].includes(broadcast.state)) ? (
          <BroadcastPreparation />
        ) : (
          <OverviewPanel
            title="Broadcast session"
            description="Destinations and capture belong to this broadcast."
          >
            <p className="text-sm font-medium">{broadcast?.name ?? "No broadcast selected"}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {broadcast
                ? "Manage your destinations, recordings and guests from the stream workspace."
                : "Create a broadcast when your source is ready to go live."}
            </p>
            <Link
              href={href("broadcasts")}
              className="mt-4 inline-flex items-center gap-1 text-xs font-medium"
            >
              View broadcasts
              <ArrowUpRight className="size-3" />
            </Link>
          </OverviewPanel>
        )}
      </div>

      <Accordion className="rounded-xl border border-border/70 bg-card/30 px-4 sm:px-5">
        {broadcast && (
          <AccordionItem value="broadcast-details">
            <AccordionTrigger className="text-sm">Broadcast activity and outputs</AccordionTrigger>
            <AccordionContent className="pb-5">
              <BroadcastDetails
                key={broadcast.id}
                projectId={projectId}
                environmentId={environmentId}
                broadcastId={broadcast.id}
                canManage={canManage}
                compact
              />
            </AccordionContent>
          </AccordionItem>
        )}
        <AccordionItem value="source-sessions">
          <AccordionTrigger className="text-sm">Source sessions</AccordionTrigger>
          <AccordionContent className="space-y-3 pb-5">
            {stream.sessions.map((s) => (
              <div key={s.id} className="rounded-lg border border-border/60 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {s.state}
                  </Badge>
                  <span className="text-muted-foreground">{s.attempts} connection attempts</span>
                </div>
                <p className="mt-2 text-muted-foreground">
                  Incoming {Math.round(s.ingressBitrate / 1000)} kbit/s / Program{" "}
                  {Math.round(s.programBitrate / 1000)} kbit/s
                </p>
                {s.lastError && (
                  <p role="status" className="mt-2 text-destructive">
                    {s.lastError}
                  </p>
                )}
              </div>
            ))}
            {!stream.sessions.length && (
              <p className="text-xs text-muted-foreground">
                No source sessions yet. Connect your encoder or room to get started.
              </p>
            )}
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
                ? "The previous credential stops working immediately and its publisher disconnects. Playback may pause. Update your encoder with the replacement and reconnect; if teardown is still pending, retry after two seconds."
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
      <details className="rounded-xl border p-4">
        <summary className="cursor-pointer text-sm font-medium">Usage by time window and resource</summary>
        <div className="mt-4 flex flex-col gap-4">
          <SimpleSelect value={usageRange} onValueChange={(v) => { setUsageReport(undefined); setUsageRange(v as "24h" | "7d" | "30d"); }} options={[{ value: "24h", label: "Last 24 hours" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]} />
          {usageError && <p role="status" className="text-sm text-muted-foreground">{usageError}</p>}
          <ServiceUsagePanel data={usageReport} />
        </div>
      </details>
    </div>
  );
}

function CredentialField({
  label,
  value,
  secret = false,
  reveal = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
  reveal?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="font-medium">{label}</p>
      <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3">
        <code className="min-w-0 flex-1 break-all text-xs">
          {secret && !reveal ? "****************" : value}
        </code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

function OverviewPanel({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className="min-w-0 scroll-mt-8 rounded-xl border border-border/70 bg-card/30 p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {description && (
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
      <div className="min-w-0 [&>p]:text-sm [&>button]:mt-3 [&>button]:rounded-lg">{children}</div>
    </section>
  );
}
