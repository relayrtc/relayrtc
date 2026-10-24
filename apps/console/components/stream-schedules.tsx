"use client";

import { PanelMessage } from "@/ui/panel-message";
import { AnimatedValue } from "@/ui/sliding-number";

import { useState } from "react";
import { streamCommand } from "@/lib/stream-api";
import type { ScheduledBroadcast, Page, StreamingOperation, MediaGrant, IngestCredential } from "@/lib/stream-types";
import { streamStatusLabel, streamOverviewPath } from "@/lib/streams";
import { formatRoomTime } from "@/lib/rooms";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { StreamPicker } from "./stream-picker";
import { BroadcastDestinationChoices } from "./stream-broadcasts";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { SettingsRow } from "@/ui/settings-row";
import { ReportMetric } from "@/ui/report-controls";
import { MediaGrantLink, MediaCopy, MediaOperationStatus } from "@/ui/media-controls";
import { OneTimeSecret } from "@/ui/developer-fields";

export function StreamSchedules({ streamId, query = "" }: { streamId?: string; query?: string }) {
  const state = useStreams();
  const [cursors, setCursors] = useState<string[]>([""]), [selected, setSelected] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const cursor = cursors[cursors.length - 1];
  const resource = useWorkspaceResource<Page<ScheduledBroadcast>>(state.path("scheduled-broadcasts", { limit: "30", ...(streamId ? { streamId } : {}), ...(cursor ? { cursor } : {}) }));
  useRealtimeRefresh(resource.refresh, !selected);
  function close() { setSelected(null); void resource.refresh().catch(() => {}); }
  const items = resource.data?.data.filter(item => `${item.name} ${item.state} ${item.id}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <><div className="panel">{items.length ? items.map(item => <SettingsRow key={item.id} icon="calendar" label={item.name} value={streamStatusLabel(item.state)} onClick={() => setSelected(item.id)} />) : <PanelMessage className="media-panel-note">{(resource.loading && !resource.data) ? "Loading schedules…" : query ? "No matches on this page." : "No scheduled broadcasts."}</PanelMessage>}</div><FormFeedback error={resource.error} />{resource.error && <Button className="workspace-section-button" onClick={() => void resource.refresh().catch(() => {})}>Reload schedules</Button>}<div className="account-pagination"><button type="button" disabled={cursors.length === 1 || resource.loading} onClick={() => setCursors(value => value.slice(0, -1))}>Previous</button><span>Page <AnimatedValue value={cursors.length} /></span><button type="button" disabled={!resource.data?.nextCursor || resource.loading} onClick={() => setCursors(value => [...value, resource.data!.nextCursor!])}>Next</button></div>{state.canManage && <Button icon="plus" className="workspace-section-button" onClick={() => setSelected("new")}>Schedule Broadcast</Button>}<Dialog open={Boolean(selected)} title={selected === "new" ? "Schedule Broadcast" : "Scheduled broadcast"} onClose={close} dismissible={!busy}>{selected && (selected === "new" ? <ScheduleForm streamId={streamId} onBusy={setBusy} onSaved={close} /> : <ScheduleDetails key={selected} id={selected} onBusy={setBusy} />)}</Dialog></>;
}
function ScheduleDetails({ id, onBusy }: { id: string; onBusy: (busy: boolean) => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const resource = useWorkspaceResource<ScheduledBroadcast>(state.path(`scheduled-broadcasts/${id}`));
  const schedule = resource.data;
  const operation = useWorkspaceResource<StreamingOperation>(schedule ? state.path(`schedule-operations/${schedule.operationId}`) : null);
  const [step, setStep] = useState<"details" | "edit" | "cancel" | "start">("details"), [grant, setGrant] = useState<MediaGrant | null>(null), [credential, setCredential] = useState<IngestCredential | null>(null);
  useRealtimeRefresh(resource.refresh, !mutation.pending && !grant && !credential && step === "details"); useRealtimeRefresh(operation.refresh, operation.data?.status === "pending" && !grant && !credential);
  async function command(action: "start-now" | "cancel") { if (!schedule) return; await mutation.run(async () => { await streamCommand(state.path(`scheduled-broadcasts/${id}/${action}`), { version: schedule.version }); setStep("details"); await resource.refresh(); await operation.refresh(); }); }
  if (!schedule) return <div className="developer-dialog-stack"><FormFeedback error={resource.error} /><Button onClick={() => void resource.refresh().catch(() => {})}>{(resource.loading && !resource.data) ? "Loading schedule…" : "Try again"}</Button></div>;
  if (step === "edit") return <ScheduleForm schedule={schedule} onBusy={onBusy} onSaved={() => { setStep("details"); void resource.refresh().catch(() => {}); }} />;
  if (credential) {
    const endpoint = credential.protocol === "rtmp" ? new URL(credential.url) : null;
    return <div className="developer-dialog-stack"><MediaCopy value={endpoint ? `${endpoint.protocol}//${endpoint.host}` : credential.url} label={endpoint ? "RTMP server" : "WHIP endpoint"} /><OneTimeSecret value={endpoint ? `${endpoint.pathname.slice(1)}?pass=${encodeURIComponent(credential.secret)}` : credential.secret} label={endpoint ? "Stream key" : "Bearer token"} onDone={() => setCredential(null)} /><p className="account-note">Credential expires {formatRoomTime(credential.expiresAt)}. Schedule admission windows still apply.</p></div>;
  }
  return <div className="developer-dialog-stack"><div className="report-dialog-values"><ReportMetric icon="streams" label="Broadcast" value={schedule.name} /><ReportMetric icon="info" label="State" value={streamStatusLabel(schedule.state)} /><ReportMetric icon="calendar" label="Starts" value={formatRoomTime(schedule.startsAt)} /><ReportMetric icon="calendar" label="Ends" value={formatRoomTime(schedule.endsAt)} /><ReportMetric icon="globe" label="Time zone" value={schedule.timeZone} /><SettingsRow icon="streams" label="View Stream" href={streamOverviewPath(schedule.streamId)} /></div><FormFeedback error={mutation.error || resource.error || operation.error || schedule.lastError || ""} />{operation.data && <MediaOperationStatus operation={{ ...operation.data, kind: "schedule" }} />}
    {grant && <><MediaGrantLink grant={grant} /><Button onClick={() => setGrant(null)}>Hide link</Button></>}
    {state.canManage && (step === "cancel" || step === "start" ? <><p className="account-note">{step === "cancel" ? "Cancel this schedule and stop its broadcast?" : "Start this scheduled broadcast now?"}</p><Button variant={step === "cancel" ? "danger" : "primary"} disabled={mutation.pending} onClick={() => void command(step === "cancel" ? "cancel" : "start-now")}>Confirm {step === "cancel" ? "cancellation" : "start"}</Button><Button disabled={mutation.pending} onClick={() => setStep("details")}>Back</Button></> : <>
      {schedule.state === "scheduled" && <><Button disabled={mutation.pending} onClick={() => setStep("edit")}>Edit timing</Button><Button variant="primary" disabled={mutation.pending} onClick={() => setStep("start")}>Start now</Button></>}
      {!["cancelled", "completed", "missed", "failed"].includes(schedule.state) && <Button variant="danger" disabled={mutation.pending} onClick={() => setStep("cancel")}>Cancel Schedule</Button>}
      <Button disabled={mutation.pending} onClick={() => void mutation.run(async () => { setGrant(await streamCommand<MediaGrant>(state.path(`scheduled-broadcasts/${id}/playback-grants`), { ttlSeconds: 300 })); })}>Playback link</Button>
      {schedule.state === "scheduled" && <Button disabled={mutation.pending} onClick={() => void mutation.run(async () => { setCredential(await streamCommand<IngestCredential>(state.path(`scheduled-broadcasts/${id}/ingest-credentials`))); })}>Encoder credential</Button>}
    </>)}
  </div>;
}
function ScheduleForm({ streamId, schedule, onBusy, onSaved }: { streamId?: string; schedule?: ScheduledBroadcast; onBusy: (busy: boolean) => void; onSaved: () => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const [selectedStream, setSelectedStream] = useState(schedule?.streamId ?? streamId ?? ""), [name, setName] = useState(schedule?.name ?? ""), [destinations, setDestinations] = useState<string[]>([]);
  const [start, setStart] = useState(schedule?.startsAt.slice(0, 16) ?? ""), [end, setEnd] = useState(schedule?.endsAt.slice(0, 16) ?? ""), [timeZone, setTimeZone] = useState(schedule?.timeZone ?? "UTC");
  const [wait, setWait] = useState(schedule?.sourceWaitSeconds ?? 120), [catchUp, setCatchUp] = useState(schedule?.catchUpSeconds ?? 300), [publisherEarly, setPublisherEarly] = useState(schedule?.publisherEarlySeconds ?? 900), [viewerEarly, setViewerEarly] = useState(schedule?.viewerEarlySeconds ?? 900), [viewerAfter, setViewerAfter] = useState(schedule?.viewerAfterSeconds ?? 0);
  return <form className="account-form" onSubmit={event => { event.preventDefault(); void mutation.run(async () => {
    const startsAt = new Date(`${start}Z`).toISOString(), endsAt = new Date(`${end}Z`).toISOString();
    if (Date.parse(endsAt) <= Date.parse(startsAt) || Date.parse(endsAt) - Date.parse(startsAt) > 86400000) throw new Error("End must follow start within 24 hours.");
    const timing = { startsAt, endsAt, timeZone, sourceWaitSeconds: wait, catchUpSeconds: catchUp, publisherEarlySeconds: publisherEarly, viewerEarlySeconds: viewerEarly, viewerAfterSeconds: viewerAfter, notifyBeforeSeconds: schedule?.notifyBeforeSeconds ?? null };
    await streamCommand(state.path(`scheduled-broadcasts${schedule ? `/${schedule.id}` : ""}`), schedule ? { version: schedule.version, timing } : { broadcast: { streamId: selectedStream, name: name.trim(), destinationIds: destinations, maxDurationSeconds: Math.max(60, Math.ceil((Date.parse(endsAt) - Date.parse(startsAt)) / 1000)) }, timing }, schedule ? "PATCH" : "POST"); onSaved();
  }); }}><fieldset disabled={mutation.pending}>
    {!schedule && <><Field label="Broadcast name"><input className="input" autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></Field>{!streamId && <StreamPicker value={selectedStream} onChange={id => { setSelectedStream(id); setDestinations([]); }} />}{selectedStream && <BroadcastDestinationChoices key={selectedStream} streamId={selectedStream} value={destinations} onChange={setDestinations} />}</>}
    <p className="account-note">Enter start and end times in UTC. The display time zone is saved with the schedule.</p><Field label="Starts (UTC)"><input className="input" type="datetime-local" required value={start} onChange={event => setStart(event.target.value)} /></Field><Field label="Ends (UTC)"><input className="input" type="datetime-local" required value={end} onChange={event => setEnd(event.target.value)} /></Field><Field label="Display time zone"><input className="input" required maxLength={80} value={timeZone} onChange={event => setTimeZone(event.target.value)} placeholder="UTC" /></Field>
    <details className="room-advanced"><summary>Admission windows</summary><div className="developer-dialog-stack"><Field label="Source wait (seconds)"><input className="input" type="number" required min={10} max={600} value={wait} onChange={event => setWait(Number(event.target.value))} /></Field><Field label="Catch-up window (seconds)"><input className="input" type="number" required min={0} max={3600} value={catchUp} onChange={event => setCatchUp(Number(event.target.value))} /></Field><Field label="Publishers may connect early (seconds)"><input className="input" type="number" required min={0} max={3600} value={publisherEarly} onChange={event => setPublisherEarly(Number(event.target.value))} /></Field><Field label="Viewers may join early (seconds)"><input className="input" type="number" required min={0} max={86400} value={viewerEarly} onChange={event => setViewerEarly(Number(event.target.value))} /></Field><Field label="Viewer access after ending (seconds)"><input className="input" type="number" required min={0} max={3600} value={viewerAfter} onChange={event => setViewerAfter(Number(event.target.value))} /></Field></div></details>
    <FormFeedback error={mutation.error} /><Button type="submit" variant="primary" disabled={!state.canManage || !selectedStream}>{mutation.pending ? "Saving…" : schedule ? "Save timing" : "Schedule Broadcast"}</Button>
  </fieldset></form>;
}
