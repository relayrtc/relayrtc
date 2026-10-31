"use client";

import {RoomActivityPanel} from "./room-activity";
import { RoomLifecycleControls } from "./room-lifecycle";

import { AnimatedValue } from "@/ui/sliding-number";
import { PanelMessage } from "@/ui/panel-message";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRooms } from "./rooms-provider";
import { useWorkspace } from "./workspace-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { useNotifications } from "./notification-provider";
import { RoomConnections } from "./room-connections";
import { EndRoomForm, RoomTokenForm } from "./room-actions";
import { roomLookupPath } from "@/lib/room-api";
import { errorMessage } from "@/lib/account-api";
import { formatRoomTime, roomStatusName } from "@/lib/rooms";
import type { RoomOverviewData } from "@/lib/room-types";
import { Dialog } from "@/ui/dialog";
import { FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { ReportMetric, ReportSection } from "@/ui/report-controls";
import { RoomConnectionTime } from "@/ui/room-connection-time";
import { SettingsRow } from "@/ui/settings-row";
import { StatusPill } from "@/ui/status-pill";
import { WorkspaceState } from "@/ui/workspace-state";

const number = new Intl.NumberFormat("en-US");

export function RoomOverview({ roomId }: { roomId: string }) {
  const resource = useWorkspaceResource<RoomOverviewData>(roomLookupPath(roomId));
  const rooms = useRooms(); const workspace = useWorkspace();
  const { notify } = useNotifications();
  const [dialog, setDialog] = useState<"token" | "end" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A token stays in its one-time dialog until the user dismisses it.
  useRealtimeRefresh(resource.refresh, dialog !== "token", 5000);
  useEffect(() => {
    if (rooms.projectId === resource.data?.room.projectId && rooms.environmentId !== resource.data.room.environmentId)
      rooms.setEnvironmentId(resource.data.room.environmentId);
  }, [resource.data, rooms.projectId, rooms.environmentId, rooms.setEnvironmentId]);
  if (!resource.data) return <WorkspaceState title="Loading room" error={resource.error} onRetry={() => void resource.refresh().catch(() => undefined)} />;
  const data = resource.data;
  const { room, canOperate, operation } = data;
  const stats = room.stats;
  const canJoin = room.status === "created" || room.status === "active";
  const differentProject = workspace.activeProjectId !== room.projectId;
  async function copyRoomId() {
    try { await navigator.clipboard.writeText(roomId); notify("Room ID copied"); }
    catch (error) { setError(errorMessage(error)); }
  }
  async function selectProject() {
    try { await workspace.switchProject(room.projectId); notify("Project selected"); }
    catch (error) { setError(errorMessage(error)); }
  }
  function changed() { void resource.refresh().catch(() => undefined); }
  return <section className="content rooms-overview" aria-label={`${room.name} overview`}>
    <Link href="/rooms" className="rooms-back"><Icon name="chevronLeft" size={16} />All Rooms</Link>
    <div className="panel room-card room-overview-summary"><span className="room-symbol"><Icon name="rooms" size={23} /></span><div className="room-card-copy"><h2 className="room-card-name">{room.name}</h2><span className="room-card-meta"><AnimatedValue value={stats.connectedParticipants} /> of <AnimatedValue value={number.format(room.maxParticipants)} /> connected</span></div><StatusPill active={room.status === "active"}>{roomStatusName(room.status)}</StatusPill></div>
    <FormFeedback error={error} />
    <ReportSection title="Room details">
      <SettingsRow icon="copy" label="Room ID" value={room.id} onClick={() => void copyRoomId()} trailing={<Icon name="copy" size={15.75} />} ariaLabel="Copy room ID" />
      <SettingsRow icon="project" label="Project" value={data.project.name} href={differentProject ? undefined : `/projects/${encodeURIComponent(room.projectId)}`} onClick={differentProject ? () => void selectProject() : undefined} />
      <SettingsRow icon="globe" label="Environment" value={data.environment.name} trailing={<></>} />
      <ReportMetric icon="users" label="Maximum participants" value={number.format(room.maxParticipants)} />
      <SettingsRow className="report-metric" icon="calendar" label="Created" value={<RoomConnectionTime value={room.createdAt} />} trailing={<></>} />
      <SettingsRow className="report-metric" icon="calendar" label="Started" value={<RoomConnectionTime value={room.startedAt} />} trailing={<></>} />
      <SettingsRow className="report-metric" icon="calendar" label="Ended" value={<RoomConnectionTime value={room.endedAt} />} trailing={<></>} />
    </ReportSection>
    {differentProject && <p className="account-section-note">This room belongs to {data.project.name}. Select the Project row to switch your workspace to it.</p>}
    <ReportSection title="Room activity">
      <ReportMetric icon="users" label="Connected now" value={`${String(stats.connectedParticipants)} / ${number.format(room.maxParticipants)}`} />
      <ReportMetric icon="users" label="Total participants" value={number.format(stats.totalParticipants)} />
      <ReportMetric icon="link" label="Connection sessions" value={number.format(stats.totalSessions)} />
      <ReportMetric icon="history" label="Reconnecting" value={number.format(stats.reconnectingSessions)} />
      <ReportMetric icon="signaling" label="Messages In" value={number.format(stats.messagesIn)} />
      <ReportMetric icon="signaling" label="Messages Out" value={number.format(stats.messagesOut)} />
    </ReportSection>
    <RoomConnections key={`${room.projectId}:${room.id}`} projectId={room.projectId} roomId={room.id} stats={stats} canOperate={canOperate} onChanged={changed} />
    <RoomActivityPanel key={`activity:${room.id}`} projectId={room.projectId} roomId={room.id} canOperate={canOperate&&canJoin}/>
    <RoomLifecycleControls key={room.id} projectId={room.projectId} roomId={room.id} canOperate={canOperate && canJoin}/>
    {Object.keys(room.metadata).length > 0 && <section className="settings-section"><h2>Metadata</h2><pre className="account-event-metadata developer-payload">{JSON.stringify(room.metadata, null, 2)}</pre></section>}
    <section className="settings-section"><h2>Room controls</h2><div className="panel">
      {canOperate && canJoin && data.tokenSigningAvailable && <SettingsRow icon="secretKeys" label="Create participant token" onClick={() => { setDialog("token"); }} />}
      {canOperate && ["created", "active", "ending"].includes(room.status) && <SettingsRow icon="stop" className="text-danger" label="End room" onClick={() => { setDialog("end"); }} />}
      {operation && <SettingsRow icon="history" label="Runtime cleanup" value={operation.status === "completed" ? "Completed" : operation.status === "failed" ? "Retrying" : operation.status === "running" ? "Running" : "Pending"} onClick={() => { setDialog("end"); }} />}
      {!canOperate && !operation && <PanelMessage className="account-panel-message">Your role has read-only access to this room.</PanelMessage>}
      {canOperate && room.status === "ended" && !operation && <PanelMessage className="account-panel-message">This room has ended.</PanelMessage>}
    </div>{canOperate && canJoin && !data.tokenSigningAvailable && <p className="account-section-note">Participant token signing is unavailable. Contact your instance administrator.</p>}</section>
    <p className="report-footnote">Updates every five seconds while visible. Last updated {formatRoomTime(data.observedAt)} · Casablanca.</p>
    <Dialog open={dialog !== null} title={dialog === "token" ? "Participant token" : room.status === "ended" ? "Cleanup progress" : "End room"} dismissible={!busy} onClose={() => { setDialog(null); changed(); }}>
      {dialog === "token" && <RoomTokenForm details={data} onBusy={setBusy} onClose={() => { setDialog(null); }} />}
      {dialog === "end" && <EndRoomForm details={data} onBusy={setBusy} onChanged={changed} onClose={() => { setDialog(null); }} />}
    </Dialog>
  </section>;
}
