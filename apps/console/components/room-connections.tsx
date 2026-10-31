"use client";

import { RoomParticipantAccess } from "./room-access";

import { AnimatedValue } from "@/ui/sliding-number";
import { PanelMessage } from "@/ui/panel-message";
import { Checkbox } from "@/ui/checkbox";

import { useState } from "react";
import { useNotifications } from "./notification-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useConnectionClock, useDebouncedValue, useRealtimeRefresh } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { accountRequest } from "@/lib/account-api";
import { roomApiPath } from "@/lib/room-api";
import { connectionDuration, formatDuration, sessionStateName } from "@/lib/rooms";
import type { RoomSession, RoomSessionDetail, RoomSessions, RoomStats, RuntimeOperation } from "@/lib/room-types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { ReportMetric } from "@/ui/report-controls";
import { RoomConnectionTime } from "@/ui/room-connection-time";
import { RoomRuntimeStatus } from "@/ui/room-runtime-status";
import { SettingsRow } from "@/ui/settings-row";
import { StatusPill } from "@/ui/status-pill";

const number = new Intl.NumberFormat("en-US");
function SessionCard({ session, observedAt, now, onClick }: { session: RoomSession; observedAt: string; now: number; onClick: () => void }) {
  const initials = session.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("");
  return <button type="button" className="room-card panel participant-card" aria-label={`Open ${session.name} connection`} onClick={onClick}><span className="participant-initials" aria-hidden="true">{initials}</span><span className="room-card-copy"><span className="room-card-name">{session.name}</span><span className="room-card-meta"><span className="connection-duration"><AnimatedValue value={formatDuration(connectionDuration(session, observedAt, now))} /></span><span className="participant-transport">{session.transport.toUpperCase()}</span></span></span><StatusPill active={session.live}>{sessionStateName(session)}</StatusPill><Icon name="chevronRight" size={17.325} className="row-chevron" /></button>;
}

export function RoomConnections({ projectId, roomId, stats, canOperate, onChanged }: { projectId: string; roomId: string; stats: RoomStats; canOperate: boolean; onChanged: () => void }) {
  const base = roomApiPath(projectId, roomId);
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search.trim());
  const [filter, setFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams({ limit: "30", offset: String(offset), status: filter, ...(debounced ? { search: debounced } : {}) });
  const resource = useWorkspaceResource<RoomSessions>(`${base}/sessions?${query}`);
  useRealtimeRefresh(resource.refresh, true, 5000);
  const now = useConnectionClock();
  const filters = [{ value: "all", label: "All", count: stats.totalSessions }, { value: "connected", label: "Connected", count: stats.connectedSessions }, { value: "disconnected", label: "Disconnected", count: stats.disconnectedSessions }];
  const data = resource.data;
  const total = data?.pagination.total ?? 0;
  return <section className="settings-section room-participants" aria-labelledby="participants-heading"><div className="participants-heading"><h2 id="participants-heading">Participant connections</h2><span><AnimatedValue value={number.format(stats.totalParticipants)} /> participants</span></div><div className="participant-tools"><div className="search-field"><Icon name="search" size={18.1125} /><input className="input" type="search" aria-label="Search participants" placeholder="Search participants" maxLength={120} value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} /></div><div className="segmented-control participant-filters" role="group" aria-label="Filter connections">{filters.map(item => <button key={item.value} type="button" className={filter === item.value ? "segment-active" : ""} aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setOffset(0); }}>{item.label}<span><AnimatedValue value={item.count} /></span></button>)}</div></div>{data?.sessions.length ? <div className="participant-list" role="list" aria-label="Room connections">{data.sessions.map(session => <div role="listitem" key={session.id}><SessionCard session={session} observedAt={data.observedAt} now={now} onClick={() => { setAccessOpen(false); setSelected(session.id); }} /></div>)}</div> : <div className="panel participant-empty"><div className="empty-state-icon"><Icon name="users" size={32} /></div><h3>{(resource.loading && !resource.data) ? "Loading connections…" : resource.error ? "Connections unavailable" : search || filter !== "all" ? "No matching connections" : "No participants yet"}</h3><p>{search || filter !== "all" ? "Try another name or connection filter." : "Participant connections and signaling activity will appear here."}</p></div>}<FormFeedback error={resource.error} />{resource.error && <Button className="workspace-section-button" onClick={() => void resource.refresh().catch(() => undefined)}>Try again</Button>}{(offset > 0 || total > 30) && <div className="account-pagination"><button className="icon-button" aria-label="Previous connections" disabled={resource.loading || offset === 0} onClick={() => { setOffset(value => Math.max(0, value - 30)); }}><Icon name="chevronLeft" size={15.75} /></button><span>{total ? `${String(Math.min(offset + 1, total))}–${String(Math.min(offset + 30, total))} of ${String(total)}` : "No results"}</span><button className="icon-button" aria-label="Next connections" disabled={resource.loading || offset + 30 >= total || offset + 30 > 100000} onClick={() => { setOffset(value => value + 30); }}><Icon name="chevronRight" size={15.75} /></button></div>}<p className="report-footnote">Each entry is a connection session. Reconnecting participants may have several entries. Times shown in Casablanca.</p><Dialog open={selected !== null} title={accessOpen ? "Participant access" : "Participant connection"} dismissible={!busy} onClose={() => { setSelected(null); }}>{selected && <ConnectionDetails key={selected} path={`${base}/sessions/${encodeURIComponent(selected)}`} base={base} accessOpen={accessOpen} onAccessChange={setAccessOpen} canOperate={canOperate} onBusy={setBusy} onDone={() => { setSelected(null); }} onChanged={() => { onChanged(); void resource.refresh().catch(() => undefined); }} />}</Dialog></section>;
}

function ConnectionDetails({ path, base, accessOpen, onAccessChange, canOperate, onBusy, onDone, onChanged }: { path: string; base: string; accessOpen: boolean; onAccessChange: (value: boolean) => void; canOperate: boolean; onBusy: (busy: boolean) => void; onDone: () => void; onChanged: () => void }) {
  const resource = useWorkspaceResource<RoomSessionDetail>(path);
  useRealtimeRefresh(resource.refresh, true, 5000);
  const now = useConnectionClock();
  const [confirming, setConfirming] = useState(false);
  const [submitted, setSubmitted] = useState<RuntimeOperation | null>(null);
  const mutation = useDeveloperMutation(onBusy);
  const { notify } = useNotifications();
  if (!resource.data) return <div className="developer-dialog-stack"><FormFeedback error={resource.error} />{resource.error ? <Button onClick={() => void resource.refresh().catch(() => undefined)}>Try again</Button> : <PanelMessage className="account-note" role="status">Loading participant connection…</PanelMessage>}</div>;
  const { session, observedAt } = resource.data;
  const operation = resource.data.operation ?? submitted;
  if (accessOpen) return <RoomParticipantAccess key={session.participantId} base={base} participantId={session.participantId} canOperate={canOperate} onBusy={onBusy} onChanged={onChanged} onBack={() => { onAccessChange(false); }} />;
  return <div className="developer-dialog-stack"><FormFeedback error={mutation.error} /><div className="report-dialog-values participant-details"><SettingsRow icon="users" label="Name" value={session.name} trailing={<></>} /><SettingsRow icon="users" label="Status" value={<StatusPill active={session.live}>{sessionStateName(session)}</StatusPill>} trailing={<></>} /><SettingsRow icon="calendar" label="Connected for" value={formatDuration(connectionDuration(session, observedAt, now))} trailing={<></>} /><SettingsRow icon="calendar" label="Entered" value={<RoomConnectionTime value={session.joinedAt} />} trailing={<></>} /><SettingsRow icon="calendar" label="Last disconnected" value={<RoomConnectionTime value={session.disconnectedAt} />} trailing={<></>} /><SettingsRow icon="history" label="Reconnected" value={<RoomConnectionTime value={session.reconnectedAt} />} trailing={<></>} /><ReportMetric icon="turn" label="Transport" value={session.transport.toUpperCase()} /><ReportMetric icon="signaling" label="Messages In" value={number.format(session.messagesIn)} /><ReportMetric icon="signaling" label="Messages Out" value={number.format(session.messagesOut)} /></div><dl className="account-detail-list"><div><dt>Participant ID</dt><dd><code>{session.participantId}</code></dd></div><div><dt>Connection ID</dt><dd><code>{session.id}</code></dd></div><div><dt>Role</dt><dd>{session.role}</dd></div>{session.externalId && <div><dt>External ID</dt><dd>{session.externalId}</dd></div>}{session.country && <div><dt>Country</dt><dd>{session.country}</dd></div>}{session.leftAt && <div><dt>Left</dt><dd><RoomConnectionTime value={session.leftAt} /></dd></div>}{session.removedAt && <div><dt>Removed</dt><dd><RoomConnectionTime value={session.removedAt} /></dd></div>}</dl>{Object.keys(session.metadata).length > 0 && <><span className="field-label">Metadata</span><pre className="account-event-metadata developer-payload">{JSON.stringify(session.metadata, null, 2)}</pre></>}{!session.removedAt && !session.participantId.startsWith("guestp_") && <div className="report-dialog-values"><SettingsRow icon="shield" label="Role and permissions" value={session.role.charAt(0).toUpperCase() + session.role.slice(1)} onClick={() => { onAccessChange(true); }} /></div>}{operation && <RoomRuntimeStatus operation={operation} />}{canOperate && !session.removedAt && !operation && !confirming && <Button variant="danger" onClick={() => { setConfirming(true); }}>Remove participant</Button>}{canOperate && confirming && !operation && <form className="account-form" onSubmit={(event) => { event.preventDefault(); void mutation.run(async () => {
    const result = await accountRequest<{ operation: RuntimeOperation | null }>(`${base}/participants/${encodeURIComponent(session.participantId)}/remove`, { confirmed: true });
    setSubmitted(result.operation); setConfirming(false); notify("Participant removal requested"); onChanged(); await resource.refresh();
  }); }}><fieldset disabled={mutation.pending}><p className="account-note">Remove {session.name}? All of this participant’s connections will be disconnected and they cannot rejoin with the same identity.</p><label className="account-checkbox"><Checkbox type="checkbox" required />I want to remove this participant.</label><div className="account-button-pair"><Button type="button" onClick={() => { setConfirming(false); }}>Cancel</Button><Button type="submit" variant="danger" disabled={mutation.pending}>{mutation.pending ? "Removing…" : "Remove participant"}</Button></div></fieldset></form>}<p className="participant-timezone">Connection time excludes disconnected periods. Times shown in Casablanca.</p><Button disabled={mutation.pending} onClick={onDone}>Done</Button></div>;
}
