"use client";

import { PanelMessage } from "@/ui/panel-message";
import { Checkbox } from "@/ui/checkbox";

import { useState } from "react";
import { streamCommand } from "@/lib/stream-api";
import { formatBitrate, formatBytes, formatTimecode, streamStatusLabel } from "@/lib/streams";
import { formatRoomTime } from "@/lib/rooms";
import type { Broadcast, BroadcastOutput, Destination, Page, Stream, StreamingOperation } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { StreamDestinations } from "./stream-destinations";
import { BroadcastStudio } from "./stream-studio";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { SettingsRow } from "@/ui/settings-row";
import { ReportMetric, ReportSection } from "@/ui/report-controls";
import { MediaOperationStatus } from "@/ui/media-controls";

export function StreamBroadcasts({ stream }: { stream: Stream }) {
  const state = useStreams();
  const [cursor, setCursor] = useState(""), [selected, setSelected] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const resource = useWorkspaceResource<Page<Broadcast>>(state.path("broadcasts", { streamId: stream.id, limit: "30", order: "newest", ...(cursor ? { cursor } : {}) }));
  useRealtimeRefresh(resource.refresh, !selected);
  function close() { setSelected(null); void resource.refresh().catch(() => {}); }
  return <>
    <ReportSection title="Broadcasts">{resource.data?.data.length ? resource.data.data.map(item => <SettingsRow key={item.id} icon="streams" label={item.name} value={streamStatusLabel(item.state)} onClick={() => setSelected(item.id)} />) : <PanelMessage className="media-panel-note">{(resource.loading && !resource.data) ? "Loading broadcasts…" : "No broadcasts yet."}</PanelMessage>}</ReportSection>
    <FormFeedback error={resource.error} />{resource.error && <Button className="workspace-section-button" onClick={() => void resource.refresh().catch(() => {})}>Reload broadcasts</Button>}
    {resource.data?.nextCursor && <Button className="workspace-section-button" disabled={resource.loading} onClick={() => setCursor(resource.data!.nextCursor!)}>Older broadcasts</Button>}{cursor && <button className="auth-text-button" onClick={() => setCursor("")}>Latest broadcasts</button>}
    {state.canManage && stream.status === "active" && <Button icon="plus" className="workspace-section-button" onClick={() => setSelected("new")}>Create Broadcast</Button>}
    <p className="account-section-note">Broadcasts manage HLS output, recording, and selected RTMP destinations. Start a broadcast after configuring its media policies.</p>
    {stream.status === "active" && <StreamDestinations streamId={stream.id} />}
    <Dialog open={Boolean(selected)} title={selected === "new" ? "Create Broadcast" : "Broadcast details"} onClose={close} dismissible={!busy}>{selected && (selected === "new" ? <BroadcastForm stream={stream} onBusy={setBusy} onCreated={setSelected} /> : <BroadcastDetails key={selected} id={selected} stream={stream} onBusy={setBusy} />)}</Dialog>
  </>;
}
export function BroadcastDestinationChoices({ streamId, value, onChange }: { streamId: string; value: string[]; onChange: (ids: string[]) => void }) {
  const state = useStreams();
  const resource = useWorkspaceResource<Page<Destination>>(streamId ? state.path(`streams/${streamId}/destinations`, { limit: "100" }) : null);
  return <div className="developer-dialog-stack"><span className="field-label">Destinations (optional)</span><FormFeedback error={resource.error} />{resource.error && <Button type="button" onClick={() => void resource.refresh().catch(() => {})}>Reload destinations</Button>}{resource.data?.data.filter(item => item.enabled).map(item => <label className="account-checkbox" key={item.id}><Checkbox type="checkbox" checked={value.includes(item.id)} onChange={() => onChange(value.includes(item.id) ? value.filter(id => id !== item.id) : [...value, item.id])} />{item.name} · {item.host}</label>)}{resource.data && !resource.data.data.some(item => item.enabled) && <p className="account-note">HLS only. Add destinations to this stream to enable restreaming.</p>}</div>;
}
function BroadcastForm({ stream, onBusy, onCreated }: { stream: Stream; onBusy: (busy: boolean) => void; onCreated: (id: string) => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const [name, setName] = useState(stream.name), [destinations, setDestinations] = useState<string[]>([]);
  return <form className="account-form" onSubmit={event => { event.preventDefault(); void mutation.run(async () => { const run = await streamCommand<Broadcast>(state.path("broadcasts"), { streamId: stream.id, name: name.trim(), destinationIds: destinations, maxDurationSeconds: stream.maxDurationSeconds }); onCreated(run.id); }); }}><fieldset disabled={mutation.pending}><Field label="Broadcast name"><input className="input" autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></Field><BroadcastDestinationChoices streamId={stream.id} value={destinations} onChange={setDestinations} /><FormFeedback error={mutation.error} /><Button type="submit" variant="primary" disabled={!name.trim() || !state.canManage}>{mutation.pending ? "Creating…" : "Create Broadcast"}</Button></fieldset></form>;
}
function BroadcastDetails({ id, stream, onBusy }: { id: string; stream: Stream; onBusy: (busy: boolean) => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const resource = useWorkspaceResource<Broadcast>(state.path(`broadcasts/${id}`));
  const outputs = useWorkspaceResource<{ data: BroadcastOutput[] }>(state.path(`broadcasts/${id}/outputs`));
  const [operation, setOperation] = useState<StreamingOperation | null>(null), [stopping, setStopping] = useState(false), [studioActive, setStudioActive] = useState(false), [studioBusy, setStudioBusy] = useState(false);
  const progress = useWorkspaceResource<StreamingOperation>(operation ? state.path(`streaming-operations/${operation.id}`) : null);
  useRealtimeRefresh(resource.refresh, !mutation.pending && !studioActive); useRealtimeRefresh(outputs.refresh, !mutation.pending && !studioActive); useRealtimeRefresh(progress.refresh, (progress.data ?? operation)?.status === "pending");
  const run = resource.data;
  async function command(path: string) { if (!run) return; await mutation.run(async () => { setOperation(await streamCommand<StreamingOperation>(state.path(path), { version: run.version })); setStopping(false); await Promise.all([resource.refresh(), outputs.refresh()]); }); }
  if (!run) return <div className="developer-dialog-stack"><FormFeedback error={resource.error} /><Button onClick={() => void resource.refresh().catch(() => {})}>{(resource.loading && !resource.data) ? "Loading broadcast…" : "Try again"}</Button></div>;
  const running = !["created", "stopped", "failed"].includes(run.state);
  return <div className="developer-dialog-stack"><div className="report-dialog-values"><ReportMetric icon="streams" label="Broadcast" value={run.name} /><ReportMetric icon="info" label="State" value={streamStatusLabel(run.state)} /><ReportMetric icon="calendar" label="Created" value={formatRoomTime(run.createdAt)} /><ReportMetric icon="calendar" label="Started" value={run.startedAt ? formatRoomTime(run.startedAt) : "Waiting"} /><ReportMetric icon="calendar" label="Ended" value={run.endedAt ? formatRoomTime(run.endedAt) : "—"} /></div><FormFeedback error={resource.error || outputs.error || mutation.error || progress.error || (run.lastError ? `Broadcast service: ${run.lastError}` : "")} />{(progress.data ?? operation) && <MediaOperationStatus operation={(progress.data ?? operation)!} />}
    {state.canManage && run.state === "created" && <Button variant="primary" disabled={mutation.pending || studioBusy} onClick={() => void command(`broadcasts/${id}/start`)}>Start Broadcast</Button>}
    {state.canManage && running && (stopping ? <div className="developer-dialog-stack"><p className="account-note">Stop this broadcast and all of its outputs?</p><Button variant="danger" disabled={mutation.pending || studioBusy} onClick={() => void command(`broadcasts/${id}/stop`)}>Confirm stop</Button><Button disabled={mutation.pending || studioBusy} onClick={() => setStopping(false)}>Cancel</Button></div> : <Button disabled={mutation.pending || studioBusy} onClick={() => setStopping(true)}>Stop Broadcast</Button>)}
    <h3 className="account-section-heading">Outputs</h3><div className="developer-attempts">{outputs.data?.data.map(item => <details className="developer-attempt" key={item.id}><summary><span>{item.destinationName ?? "HLS"}</span><span>{streamStatusLabel(item.state)}</span></summary><div className="media-output-body"><div className="report-dialog-values"><ReportMetric icon="egress" label="Bitrate" value={formatBitrate(item.bitrate)} /><ReportMetric icon="usage" label="Delivered" value={formatBytes(item.bytes)} /><ReportMetric icon="history" label="Output time" value={formatTimecode(item.outputSeconds)} /><ReportMetric icon="quality" label="Dropped frames" value={String(item.droppedFrames)} /><ReportMetric icon="history" label="Attempts" value={String(item.attempts)} /></div><FormFeedback error={item.lastError ?? undefined} />{state.canManage && running && ["retry", "failed"].includes(item.state) && <Button disabled={mutation.pending || studioBusy} onClick={() => void command(`broadcasts/${id}/outputs/${item.id}/retry`)}>Retry output</Button>}</div></details>)}</div>
    <BroadcastStudio stream={stream} broadcast={run} onBusy={value => { setStudioBusy(value); onBusy(value); }} onActiveChange={setStudioActive} disabled={mutation.pending} />
  </div>;
}
