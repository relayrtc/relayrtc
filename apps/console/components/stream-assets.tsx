"use client";

import { LoadingSkeleton } from "@/ui/skeleton";
import { AnimatedValue } from "@/ui/sliding-number";
import { PanelMessage } from "@/ui/panel-message";

import { useState } from "react";
import { formatBytes, formatTimecode, streamOverviewPath, streamStatusLabel } from "@/lib/streams";
import { formatRoomTime } from "@/lib/rooms";
import { streamCommand } from "@/lib/stream-api";
import type { Clip, Recording, Page, MediaAsset, MediaGrant } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";
import { ClipForm } from "./create-clip-dialog";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icon";
import { ReportMetric } from "@/ui/report-controls";
import { SettingsRow } from "@/ui/settings-row";
import { StatusPill } from "@/ui/status-pill";
import { FormFeedback, Field } from "@/ui/auth-fields";
import { MediaGrantLink } from "@/ui/media-controls";

export function StreamAssets(props: { kind: "recording" | "clip"; query?: string; streamId?: string; onClipCreated?: () => void }) {
  const state = useStreams();
  return <AssetsList {...props} key={`${state.scope}:${props.kind}:${props.streamId ?? ""}`} />;
}
function AssetsList({ kind, query = "", streamId, onClipCreated }: { kind: "recording" | "clip"; query?: string; streamId?: string; onClipCreated?: () => void }) {
  const state = useStreams(), { notify } = useNotifications();
  const [selectedId, setSelectedId] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [cursors, setCursors] = useState<string[]>([""]);
  const cursor = cursors[cursors.length - 1];
  const path = streamId ? `streams/${streamId}/${kind === "recording" ? "recordings" : "clips"}` : kind === "recording" ? "recordings" : "clips";
  const resource = useWorkspaceResource<Page<Recording | Clip>>(state.ready ? state.path(path, { limit: "30", ...(cursor ? { cursor } : {}) }) : null);
  useRealtimeRefresh(resource.refresh, !selectedId);
  const items = resource.data?.data.filter(item => `${"label" in item ? item.label : "Recording"} ${item.id} ${item.streamId} ${item.state}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  function close() { setSelectedId(null); void resource.refresh().catch(() => {}); }
  return <>
    <FormFeedback error={resource.error} />{resource.error && <Button onClick={() => void resource.refresh().catch(() => {})}>Try again</Button>}
    {!resource.data && resource.loading ? <LoadingSkeleton rows={3} label="Loading data" /> : resource.data && (items.length ? <div className="room-list stream-asset-list">{items.map(item => <button key={item.id} type="button" className="panel room-card stream-asset-card" onClick={() => setSelectedId(item.id)}><span className="room-symbol"><Icon name={kind === "recording" ? "recording" : "clip"} size={23} /></span><span className="room-card-copy"><span className="room-card-name">{"label" in item ? item.label || "Untitled clip" : `Recording ${item.id.slice(-8)}`}</span><span className="room-card-meta"><AnimatedValue value={formatTimecode(item.durationSeconds)} /> · <AnimatedValue value={formatBytes(item.storedBytes)} /></span></span><StatusPill active={item.state === "recording" || item.state === "ready"}>{streamStatusLabel(item.state)}</StatusPill><Icon name="chevronRight" size={17.325} className="row-chevron" /></button>)}</div> : <div className="empty-state streams-empty"><div className="empty-state-icon"><Icon name={kind === "recording" ? "recording" : "clip"} size={32} /></div><h2>{query ? "No matches on this page" : kind === "recording" ? "No recordings yet" : "No clips yet"}</h2><p>{kind === "recording" ? "Start recording from a stream or configure automatic recording." : "Save moments from a retained recording or buffer."}</p></div>)}
    <div className="account-pagination"><button type="button" disabled={cursors.length === 1 || resource.loading} onClick={() => setCursors(value => value.slice(0, -1))}>Previous</button><span>Page <AnimatedValue value={cursors.length} /></span><button type="button" disabled={!resource.data?.nextCursor || resource.loading} onClick={() => setCursors(value => [...value, resource.data!.nextCursor!])}>Next</button></div>
    <Dialog open={Boolean(selectedId)} title={kind === "recording" ? "Recording details" : "Clip details"} onClose={close} dismissible={!busy}>{selectedId && <AssetDetails key={selectedId} id={selectedId} kind={kind} onBusy={setBusy} onClipCreated={() => { close(); notify("Clip queued"); onClipCreated?.(); }} />}</Dialog>
  </>;
}
function AssetDetails({ id, kind, onBusy, onClipCreated }: { id: string; kind: "recording" | "clip"; onBusy: (busy: boolean) => void; onClipCreated: () => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy), { notify } = useNotifications();
  const resource = useWorkspaceResource<Recording | Clip>(state.path(`${kind === "recording" ? "recordings" : "clips"}/${id}`));
  const item = resource.data;
  const asset = useWorkspaceResource<MediaAsset>(item ? state.path(`assets/${item.assetId}`) : null);
  const [step, setStep] = useState<"details" | "clip" | "delete">("details");
  const [clippingBusy, setClippingBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [grant, setGrant] = useState<MediaGrant | null>(null);
  useRealtimeRefresh(resource.refresh, !grant && !mutation.pending && step === "details");
  useRealtimeRefresh(asset.refresh, !grant && !mutation.pending && step === "details" && Boolean(item));
  async function action(resourcePath: string, body: unknown = {}, method: "POST" | "DELETE" = "POST") {
    await mutation.run(async () => { await streamCommand(state.path(resourcePath), body, method); setGrant(null); setStep("details"); setConfirmation(""); notify("Request accepted"); await Promise.all([resource.refresh(), asset.refresh()]); });
  }
  async function access(action: "playback" | "download") {
    if (!item) return;
    await mutation.run(async () => {
      const value = await streamCommand<MediaGrant>(state.path(`assets/${item.assetId}/access-grants`), { audience: kind === "clip" && !("published" in item && item.published) ? "preview" : "viewer", action, ttlSeconds: 300 });
      setGrant(value);
    });
  }
  if (!item) return <div className="developer-dialog-stack"><FormFeedback error={resource.error} />{resource.loading ? <PanelMessage className="account-note" role="status">Loading media…</PanelMessage> : <Button onClick={() => void resource.refresh().catch(() => {})}>Try again</Button>}</div>;
  if (step === "clip") return <div className="developer-dialog-stack"><ClipForm open sourceId={item.id} streamId={item.streamId} onBusy={value => { setClippingBusy(value); onBusy(value); }} onCreated={onClipCreated} /><Button disabled={clippingBusy} onClick={() => setStep("details")}>Back to details</Button></div>;
  const clip = "label" in item ? item : null, recording = "policy" in item ? item : null;
  if (step === "delete") return <form className="account-form" onSubmit={event => { event.preventDefault(); void action(`${kind === "recording" ? "recordings" : "clips"}/${id}`, {}, "DELETE"); }}><fieldset disabled={mutation.pending}><p className="account-note">This deletes the media and revokes its access links. Cleanup runs in the background.</p><Field label="Enter DELETE to confirm"><input className="input" autoFocus autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} required pattern="DELETE" /></Field><FormFeedback error={mutation.error} /><Button type="submit" variant="danger" disabled={confirmation !== "DELETE"}>{mutation.pending ? "Requesting deletion…" : "Delete media"}</Button><Button type="button" onClick={() => setStep("details")}>Cancel</Button></fieldset></form>;
  const available = item.state === "ready" && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now());
  const canAccess = available && (kind === "recording" || state.canManage || clip?.published);
  return <div className="developer-dialog-stack"><div className="report-dialog-values">
    <ReportMetric icon="recording" label="Status" value={streamStatusLabel(item.state)} /><ReportMetric icon="calendar" label="Duration" value={formatTimecode(item.durationSeconds)} /><ReportMetric icon="usage" label="Stored media" value={formatBytes(item.storedBytes)} /><ReportMetric icon="calendar" label="Created" value={formatRoomTime(item.createdAt)} /><ReportMetric icon="calendar" label="Expires" value={item.expiresAt ? formatRoomTime(item.expiresAt) : "Not finalized"} />
    {recording && <><ReportMetric icon="recording" label="Segments" value={String(recording.segmentCount)} /><ReportMetric icon="info" label="Partial recording" value={recording.partial ? "Yes" : "No"} /><ReportMetric icon="calendar" label="Started" value={recording.startedAt ? formatRoomTime(recording.startedAt) : "Waiting"} /><ReportMetric icon="calendar" label="Ended" value={recording.endedAt ? formatRoomTime(recording.endedAt) : "—"} /></>}
    {clip && <><ReportMetric icon="clip" label="Clip name" value={clip.label || "Untitled clip"} /><ReportMetric icon="history" label="Requested range" value={`${formatTimecode(clip.requestedStartSeconds)} – ${formatTimecode(clip.requestedEndSeconds)}`} /><ReportMetric icon="history" label="Rendered range" value={`${formatTimecode(clip.resolvedStartSeconds)} – ${formatTimecode(clip.resolvedEndSeconds)}`} /><ReportMetric icon="quality" label="Cut mode" value={clip.cutMode} /><ReportMetric icon="globe" label="Published" value={clip.published ? "Yes" : "No"} />{clip.progress && <ReportMetric icon="history" label="Render progress" value={`${streamStatusLabel(clip.progress.stage)} · ${clip.progress.copiedObjects}/${clip.progress.totalObjects} objects`} />}</>}
    {asset.data && <ReportMetric icon="recording" label="Formats" value={asset.data.formats.join(", ").toUpperCase() || "Pending"} />}
    <SettingsRow icon="streams" label="View Stream" href={streamOverviewPath(item.streamId)} />
  </div><FormFeedback error={mutation.error || resource.error || asset.error || (item.lastError ? `Media service: ${item.lastError}` : "")} />
    {canAccess && <div className="account-button-pair"><Button icon="play" disabled={mutation.pending} onClick={() => void access("playback")}>Playback link</Button><Button icon="download" disabled={mutation.pending || !asset.data?.formats.includes("mp4")} onClick={() => void access("download")}>Download MP4</Button></div>}
    {grant && <><MediaGrantLink grant={grant} label={grant.url.includes("download.mp4") ? "Download MP4" : "Open HLS media"} /><Button onClick={() => setGrant(null)}>Hide access link</Button></>}
    {state.canManage && <>
      {recording && ["queued", "recording"].includes(item.state) && <Button disabled={mutation.pending} onClick={() => void action(`recordings/${id}/stop`)}>Stop recording</Button>}
      {clip && available && !clip.published && <Button variant="primary" disabled={mutation.pending} onClick={() => void action(`clips/${id}/publish`)}>Publish Clip</Button>}
      {recording && ["recording", "finalizing", "ready"].includes(item.state) && <Button icon="clip" disabled={mutation.pending} onClick={() => { setGrant(null); setStep("clip"); }}>Create Clip</Button>}
      {available && <Button disabled={mutation.pending} onClick={() => void action(`assets/${item.assetId}/access-grants/revoke`)}>Revoke access links</Button>}
      {!["deleting", "deleted"].includes(item.state) && <Button variant="danger" disabled={mutation.pending} onClick={() => { setGrant(null); setStep("delete"); }}>Delete {kind === "recording" ? "Recording" : "Clip"}</Button>}
    </>}
  </div>;
}
