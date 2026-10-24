"use client";

import { LoadingSkeleton } from "@/ui/skeleton";
import { AnimatedValue } from "@/ui/sliding-number";

import Link from "next/link";
import { useState } from "react";
import { useStreams } from "./streams-provider";
import { useRooms } from "./rooms-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh, useConnectionClock } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { streamCommand } from "@/lib/stream-api";
import { streamTypeLabel, streamStatusLabel, formatBytes, formatTimecode, formatBitrate } from "@/lib/streams";
import { roomOverviewPath, formatRoomTime } from "@/lib/rooms";
import type { StreamDetails, StreamPlayback, StreamUsage, StreamingOperation } from "@/lib/stream-types";
import { StreamAssets } from "./stream-assets";
import { StreamMediaPolicies } from "./stream-media-policies";
import { StreamBroadcasts } from "./stream-broadcasts";
import { StreamSources } from "./stream-sources";
import { StreamSchedules } from "./stream-schedules";
import { StreamConfiguration } from "./stream-configuration";
import { StreamActionForm, type StreamAction } from "./stream-actions";
import { CreateClipDialog } from "./create-clip-dialog";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icon";
import { FormFeedback } from "@/ui/auth-fields";
import { DeveloperEnvironment } from "@/ui/developer-fields";
import { MediaOperationStatus } from "@/ui/media-controls";
import { SettingsRow } from "@/ui/settings-row";
import { ReportMetric, ReportSection } from "@/ui/report-controls";
import { StatusPill } from "@/ui/status-pill";

export function StreamOverview({ streamId }: { streamId: string }) {
  const state = useStreams(), rooms = useRooms();
  return <section className="content stream-overview" aria-label="Stream overview">
    <Link href="/streams" className="rooms-back"><Icon name="chevronLeft" size={16} />All Streams</Link>
    <DeveloperEnvironment environments={rooms.environments} value={state.environmentId} onChange={rooms.setEnvironmentId} disabled={!state.ready} />
    {state.ready ? <StreamView key={`${state.scope}:${streamId}`} streamId={streamId} /> : <><FormFeedback error={state.error} /><LoadingSkeleton rows={3} label="Loading data" />{state.error && <Button onClick={() => void rooms.refresh().catch(() => {})}>Try again</Button>}</>}
  </section>;
}
function StreamView({ streamId }: { streamId: string }) {
  const state = useStreams(), mutation = useDeveloperMutation();
  const [dialog, setDialog] = useState<StreamAction | "configuration" | null>(null), [busy, setBusy] = useState(false), [clipping, setClipping] = useState(false);
  const [operation, setOperation] = useState<StreamingOperation | null>(null);
  const resource = useWorkspaceResource<StreamDetails>(state.path(`streams/${streamId}`));
  const stream = resource.data;
  const playback = useWorkspaceResource<StreamPlayback>(stream ? state.path(`streams/${streamId}/playback`) : null);
  const usage = useWorkspaceResource<StreamUsage>(stream ? state.path(`streams/${streamId}/usage`) : null);
  const progress = useWorkspaceResource<StreamingOperation>(operation ? state.path(`streaming-operations/${operation.id}`) : null);
  const currentOperation = progress.data ?? operation;
  useRealtimeRefresh(resource.refresh, !dialog && !clipping && !mutation.pending, 1000);
  useRealtimeRefresh(playback.refresh, Boolean(stream) && !dialog && !clipping, 1000);
  useRealtimeRefresh(usage.refresh, Boolean(stream) && !dialog && !clipping, 1000);
  useRealtimeRefresh(progress.refresh, currentOperation?.status === "pending" && !dialog, 1000);
  const now = useConnectionClock();
  if (!stream) return <div className="developer-dialog-stack"><FormFeedback error={resource.error} />{resource.loading ? <LoadingSkeleton rows={3} label="Loading data" /> : <><p className="account-note">This stream may be unavailable in the selected project or environment.</p><Button onClick={() => void resource.refresh().catch(() => {})}>Try again</Button></>}</div>;
  const session = stream.sessions[0], running = session && !["ended", "failed"].includes(session.state);
  const active = stream.status === "active";
  function close() { setDialog(null); void Promise.allSettled([resource.refresh(), playback.refresh(), usage.refresh()]); }
  async function start() {
    await mutation.run(async () => { setOperation(await streamCommand<StreamingOperation>(state.path(`streams/${streamId}/source-sessions`))); await resource.refresh(); });
  }
  return <>
    <div className="panel room-card room-overview-summary media-summary"><span className="room-symbol"><Icon name={stream.source.kind === "room" ? "rooms" : "streams"} size={23} /></span><div className="room-card-copy"><h2 className="room-card-name">{stream.name}</h2><span className="room-card-meta">{streamTypeLabel(stream.source.kind)}</span></div><StatusPill active={playback.data?.readiness.viewerReady ?? false}>{stream.status !== "active" ? streamStatusLabel(stream.status) : playback.data ? streamStatusLabel(playback.data.readiness.status) : session ? streamStatusLabel(session.state) : "Waiting"}</StatusPill></div>
    <ReportSection title="Stream details"><ReportMetric icon="copy" label="Stream ID" value={stream.id} /><ReportMetric icon="streams" label="Stream type" value={streamTypeLabel(stream.source.kind)} />{stream.source.kind === "room" ? <SettingsRow icon="rooms" label="Source room" value={stream.source.roomId} href={roomOverviewPath(stream.source.roomId)} /> : state.canManage && active && <SettingsRow icon="ingress" label="Encoder setup" onClick={() => setDialog("setup")} />}<ReportMetric icon="calendar" label="Created" value={formatRoomTime(stream.createdAt)} /><ReportMetric icon="recording" label="Output" value={stream.profile.audioOnly ? "Audio only" : `${stream.profile.width} × ${stream.profile.height} · ${stream.profile.fps} fps`} /><ReportMetric icon="history" label="Maximum duration" value={formatTimecode(stream.maxDurationSeconds)} />{state.canManage && active && <SettingsRow icon="edit" label="Edit configuration" onClick={() => setDialog("configuration")} />}</ReportSection>
    <ReportSection title="Stream activity"><ReportMetric icon="ingress" label="Publisher connected" value={playback.data ? playback.data.readiness.publisherConnected ? "Yes" : "No" : playback.error ? "Unavailable" : "Loading…"} /><ReportMetric icon="play" label="Viewer ready" value={playback.data ? playback.data.readiness.viewerReady ? "Yes" : "No" : playback.error ? "Unavailable" : "Loading…"} /><ReportMetric icon="calendar" label="Session duration" value={session ? formatTimecode((Date.parse(session.endedAt ?? new Date(now).toISOString()) - Date.parse(session.createdAt)) / 1000) : "—"} /><ReportMetric icon="ingress" label="Ingress bitrate" value={formatBitrate(session?.ingressBitrate ?? 0)} /><ReportMetric icon="egress" label="Program bitrate" value={formatBitrate(session?.programBitrate ?? 0)} />{usage.data && <><ReportMetric icon="history" label="Source time" value={formatTimecode(usage.data.sourceSeconds)} /><ReportMetric icon="ingress" label="Ingress data" value={formatBytes(usage.data.ingressBytes)} /><ReportMetric icon="egress" label="Program data" value={formatBytes(usage.data.programBytes)} /><ReportMetric icon="info" label="Usage coverage" value={usage.data.coverage} /></>}</ReportSection>
    <FormFeedback error={mutation.error || resource.error || playback.error || usage.error} />
    {currentOperation && <MediaOperationStatus operation={currentOperation} />}<FormFeedback error={progress.error} />
    {state.canManage && active && <><div className="account-button-pair workspace-section-button"><Button icon="play" disabled={!playback.data?.readiness.viewerReady} onClick={() => setDialog("playback")}>Live playback</Button><Button icon="history" onClick={() => setDialog("dvr")}>DVR playback</Button></div><Button className="workspace-section-button" onClick={() => setDialog("revoke")}>Revoke playback links</Button>{stream.source.kind === "room" && !running && <Button variant="primary" icon="play" className="workspace-section-button" disabled={mutation.pending || currentOperation?.status === "pending"} onClick={() => void start()}>{mutation.pending ? "Requesting…" : "Start room source"}</Button>}{running && <Button icon="stop" className="workspace-section-button" onClick={() => setDialog("stop")}>Stop source</Button>}</>}
    {active && <StreamMediaPolicies stream={stream} />}
    <StreamBroadcasts stream={stream} />
    {active && stream.source.kind !== "room" && <StreamSources stream={stream} />}
    <details className="media-section-details"><summary>Scheduled broadcasts</summary><StreamSchedules streamId={stream.id} /></details>
    <section className="settings-section" aria-label="Stream recordings"><h2>Recordings</h2><StreamAssets kind="recording" streamId={stream.id} /></section>
    <section className="settings-section" aria-label="Stream clips"><h2>Clips</h2><StreamAssets kind="clip" streamId={stream.id} />{state.canManage && active && <Button icon="plus" className="create-room-button" onClick={() => setClipping(true)}>Create Clip</Button>}</section>
    <details className="media-section-details"><summary>Recent source sessions</summary><div className="developer-attempts">{stream.sessions.length ? stream.sessions.map(item => <details className="developer-attempt" key={item.id}><summary><span>{streamStatusLabel(item.state)}</span><span>{formatRoomTime(item.createdAt)}</span></summary><dl className="account-detail-list"><div><dt>Session ID</dt><dd>{item.id}</dd></div><div><dt>Desired state</dt><dd>{item.desiredState}</dd></div><div><dt>Last heartbeat</dt><dd>{item.lastHeartbeatAt ? formatRoomTime(item.lastHeartbeatAt) : "—"}</dd></div><div><dt>Ended</dt><dd>{item.endedAt ? formatRoomTime(item.endedAt) : "—"}</dd></div><div><dt>Attempts</dt><dd><AnimatedValue value={item.attempts} /></dd></div><div><dt>Source codecs</dt><dd>{item.sourceInfo.tracks?.map(track => track.codec).join(", ") || "—"}</dd></div>{item.lastError && <div><dt>Error</dt><dd>{item.lastError}</dd></div>}</dl></details>) : <p className="account-note">No source sessions yet.</p>}</div></details>
    {state.canManage && active && <Button variant="danger" className="account-section-action" onClick={() => setDialog("delete")}>Delete Stream</Button>}
    <Dialog open={Boolean(dialog)} title={dialog === "setup" ? "Encoder setup" : dialog === "configuration" ? "Stream configuration" : dialog === "stop" ? "Stop source" : dialog === "delete" ? "Delete Stream" : dialog === "revoke" ? "Revoke playback links" : dialog === "dvr" ? "DVR playback" : "Live playback"} onClose={close} dismissible={!busy}>{dialog && (dialog === "configuration" ? <StreamConfiguration stream={stream} onBusy={setBusy} onSaved={close} /> : <StreamActionForm key={dialog} stream={stream} action={dialog} onBusy={setBusy} onDone={close} onOperation={setOperation} />)}</Dialog>
    <CreateClipDialog open={clipping} streamId={streamId} onClose={() => setClipping(false)} onCreated={() => setClipping(false)} />
  </>;
}
