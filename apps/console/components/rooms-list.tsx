"use client";

import { PanelMessage } from "@/ui/panel-message";
import { Select } from "@/ui/select";
import { AnimatedValue } from "@/ui/sliding-number";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useNotifications } from "./notification-provider";
import { useRooms } from "./rooms-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDebouncedValue, useRealtimeRefresh } from "./use-realtime-refresh";
import { CreateRoomDialog } from "./create-room-dialog";
import { roomOverviewPath, roomStatusName } from "@/lib/rooms";
import { roomEnvironmentPath } from "@/lib/room-api";
import type { RealtimeSummary, Room, RoomConnection, RoomStatus } from "@/lib/room-types";
import { Button } from "@/ui/button";
import { DeveloperEnvironment } from "@/ui/developer-fields";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { ReportMetric, ReportSection } from "@/ui/report-controls";
import { StatusPill } from "@/ui/status-pill";
import { WorkspaceState } from "@/ui/workspace-state";

const number = new Intl.NumberFormat("en-US");
const statuses: RoomStatus[] = ["created", "active", "ending", "ended", "failed"];

export function RoomsList({ realtime = false }: { realtime?: boolean }) {
  const rooms = useRooms();
  if (!rooms.ready) return <WorkspaceState title="Loading rooms" error={rooms.error} onRetry={() => void rooms.refresh().catch(() => {})} />;
  return <section className="content rooms-content" aria-label={realtime ? "Realtime" : "Rooms"}>
    <nav className="segmented-control workspace-tabs room-view-tabs" aria-label="Room views"><Link href="/rooms" className={!realtime ? "segment-active" : ""} aria-current={!realtime ? "page" : undefined}>Rooms</Link><Link href="/realtime" className={realtime ? "segment-active" : ""} aria-current={realtime ? "page" : undefined}>Realtime</Link></nav>
    <DeveloperEnvironment environments={rooms.environments} value={rooms.environmentId} onChange={rooms.setEnvironmentId} />
    {rooms.projectId && rooms.environmentId
      ? <RoomsInEnvironment key={`${rooms.projectId}:${rooms.environmentId}:${realtime}`} projectId={rooms.projectId} environmentId={rooms.environmentId} realtime={realtime} />
      : <PanelMessage className="account-panel-message">This project has no active environments.</PanelMessage>}
  </section>;
}

function RoomsInEnvironment({ projectId, environmentId, realtime }: { projectId: string; environmentId: string; realtime: boolean }) {
  const { canOperate } = useRooms();
  const { notify } = useNotifications(); const router = useRouter();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const [status, setStatus] = useState(realtime ? "active" : "all");
  const [cursors, setCursors] = useState<string[]>([""]);
  const [creating, setCreating] = useState(false);
  const base = roomEnvironmentPath(projectId, environmentId);
  const query = new URLSearchParams({ limit: "30", ...(cursors.at(-1) ? { cursor: cursors.at(-1)! } : {}), ...(status === "all" ? {} : { status }), ...(debouncedSearch ? { search: debouncedSearch } : {}) });
  const resource = useWorkspaceResource<RoomConnection>(`${base}/rooms?${query}`);
  const summary = useWorkspaceResource<RealtimeSummary>(`${base}/summary`);
  useRealtimeRefresh(resource.refresh);
  useRealtimeRefresh(summary.refresh, true, 1000);
  function created(room: Room) { notify("Room created"); router.push(roomOverviewPath(room.id)); }

  return <>
    {realtime && (summary.data ? <ReportSection title="Realtime overview">
      <ReportMetric icon="rooms" label="Active rooms" value={number.format(summary.data.activeRooms)} />
      <ReportMetric icon="users" label="Connected participants" value={number.format(summary.data.connectedParticipants)} />
      <ReportMetric icon="link" label="Live connections" value={number.format(summary.data.connectedSessions)} />
      <ReportMetric icon="history" label="Reconnecting" value={number.format(summary.data.reconnectingSessions)} />
      <ReportMetric icon="signaling" label="Messages In" value={number.format(summary.data.messagesIn)} />
      <ReportMetric icon="signaling" label="Messages Out" value={number.format(summary.data.messagesOut)} />
    </ReportSection> : <div className="panel account-panel-message" role="status">{summary.error ? "Realtime overview unavailable." : "Loading realtime overview…"}</div>)}
    {realtime && <><FormFeedback error={summary.error} />{summary.error && <Button className="workspace-section-button" onClick={() => void summary.refresh().catch(() => {})}>Try again</Button>}</>}
    <div className="search-field workspace-search"><Icon name="search" size={18.1125} /><input className="input" type="search" aria-label="Search rooms" placeholder="Search rooms" maxLength={120} value={search} onChange={event => { setSearch(event.target.value); setCursors([""]); }} /></div>
    <div className="panel account-filter-form room-status-filter"><Field label="Status"><Select className="input" value={status} onChange={event => { setStatus(event.target.value); setCursors([""]); }}><option value="all">All rooms</option>{statuses.map(item => <option key={item} value={item}>{roomStatusName(item)}</option>)}</Select></Field></div>
    <div className="rooms-list-heading"><h2>{realtime ? "Live Rooms" : "Your Rooms"}</h2><button className="auth-text-button" disabled={resource.loading} onClick={() => { void resource.refresh().catch(() => {}); void summary.refresh().catch(() => {}); }}>Refresh</button></div>
    {resource.data?.nodes.length ? <div className="room-list">{resource.data.nodes.map(room => <Link href={roomOverviewPath(room.id)} key={room.id} className="room-card panel" aria-label={`Open ${room.name}`}>
      <span className="room-symbol"><Icon name="rooms" size={23} /></span><span className="room-card-copy"><span className="room-card-name">{room.name}</span><span className="room-card-meta"><AnimatedValue value={room.stats.connectedParticipants} /> of <AnimatedValue value={number.format(room.maxParticipants)} /> connected</span></span><StatusPill active={room.status === "active"}>{roomStatusName(room.status)}</StatusPill><Icon name="chevronRight" size={17.325} className="row-chevron" />
    </Link>)}</div> : <div className="empty-state rooms-empty"><div className="empty-state-icon"><Icon name="rooms" size={37.8} /></div><h2>{(resource.loading && !resource.data) ? "Loading rooms…" : resource.error ? "Rooms unavailable" : debouncedSearch || status !== "all" ? "No rooms found" : "A place to connect."}</h2><p>{resource.loading ? "Please wait a moment." : resource.error ? "Try loading this environment again." : debouncedSearch || status !== "all" ? "Try another room name, ID, or status." : "Create a room and bring your people together."}</p></div>}
    <FormFeedback error={resource.error} />{resource.error && <Button onClick={() => void resource.refresh().catch(() => {})}>Try again</Button>}
    {(cursors.length > 1 || resource.data?.pageInfo.hasNextPage) && <div className="account-pagination"><button className="icon-button" aria-label="Previous rooms" disabled={resource.loading || cursors.length === 1} onClick={() => setCursors(values => values.slice(0, -1))}><Icon name="chevronLeft" size={15.75} /></button><span>Page <AnimatedValue value={cursors.length} /></span><button className="icon-button" aria-label="Next rooms" disabled={resource.loading || !resource.data?.pageInfo.hasNextPage} onClick={() => { const cursor = resource.data?.pageInfo.endCursor; if (cursor) setCursors(values => [...values, cursor]); }}><Icon name="chevronRight" size={15.75} /></button></div>}
    {canOperate && <Button icon="plus" className="create-room-button" onClick={() => setCreating(true)}>Create Room</Button>}
    <p className="rooms-list-note">{canOperate ? "Updates every 10 seconds while visible." : "Read-only access. Owners, admins, and developers can manage rooms."}</p>
    {realtime && <p className="account-section-note">Signaling counters include all retained room connections in this environment.</p>}
    <CreateRoomDialog open={creating} onClose={() => setCreating(false)} onCreated={created} />
  </>;
}
