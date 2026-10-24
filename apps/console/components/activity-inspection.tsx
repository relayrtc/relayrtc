"use client";

import { PanelMessage } from "@/ui/panel-message";
import { AnimatedValue } from "@/ui/sliding-number";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { useRooms } from "./rooms-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useReportingRefresh } from "./use-reporting-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { activityPath, activityHref, reportTimestamp } from "@/lib/reporting-api";
import type { ActivityInspection, ActivityView, InspectionGroup, InspectionRecord } from "@/lib/reporting-types";
import { roomOverviewPath, formatRoomTime } from "@/lib/rooms";
import { streamOverviewPath } from "@/lib/streams";
import { formatMetric } from "@/lib/rtc-reports";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { FormFeedback } from "@/ui/auth-fields";
import { SettingsRow } from "@/ui/settings-row";
import { ReportSection } from "@/ui/report-controls";
import { ReportingState } from "@/ui/reporting-state";

export function ActivityInspectionView({ view, resourceId, projectId, environmentId }: { view: ActivityView; resourceId: string; projectId?: string; environmentId?: string }) {
  const workspace = useWorkspace(), rooms = useRooms();
  const actualProject = projectId ?? workspace.activeProjectId, actualEnvironment = environmentId ?? rooms.environmentId;
  return <section className="content reporting-content" aria-label="Activity details"><Link href="/activity" className="account-back"><Icon name="chevronLeft" size={15.75} />All activity</Link>{actualProject && actualEnvironment ? <Inspection key={`${actualProject}:${actualEnvironment}:${view}:${resourceId}`} projectId={actualProject} environmentId={actualEnvironment} view={view} resourceId={resourceId} /> : <ReportingState error={rooms.error || (rooms.ready ? "Choose an active environment in Activity first." : "")} loading={!rooms.ready && !rooms.error} label="activity scope" onRetry={() => void rooms.refresh().catch(() => {})} />}</section>;
}
function Inspection({ projectId, environmentId, view, resourceId }: { projectId: string; environmentId: string; view: ActivityView; resourceId: string }) {
  const workspace = useWorkspace(), rooms = useRooms(), mutation = useDeveloperMutation();
  const [page, setPage] = useState(0);
  const resource = useWorkspaceResource<ActivityInspection>(`${activityPath(projectId, environmentId)}/${view}/${encodeURIComponent(resourceId)}?${new URLSearchParams({ page: String(page) })}`);
  useReportingRefresh(resource.refresh);
  const data = resource.data, record = data?.room ?? data?.stream ?? data?.asset ?? data?.source;
  useEffect(() => { if (workspace.activeProjectId === projectId && rooms.environments.some(item => item.id === environmentId)) rooms.setEnvironmentId(environmentId); }, [workspace.activeProjectId, projectId, environmentId, rooms.environments, rooms.setEnvironmentId]);
  const context = { projectId, environmentId };
  const groups: InspectionGroup[] = data ? [...(data.sessions ? [{ title: view === "rooms" ? "Participant connections" : "Source sessions", rows: data.sessions, hasNext: false }] : []), ...(data.broadcasts ? [{ title: "Broadcasts", rows: data.broadcasts, hasNext: false }] : []), ...(data.outputs ? [{ title: "Broadcast outputs", rows: data.outputs, hasNext: false }] : []), ...data.groups] : [];
  if (!data || !record) return <ReportingState loading={resource.loading} error={resource.error} label="activity details" onRetry={() => void resource.refresh().catch(() => {})} />;
  const displayName = typeof record.name === "string" ? record.name : resourceId;
  async function exportDetails() {
    const blob = new Blob([JSON.stringify({ scope: context, ...data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `relayrtc-${view}-${resourceId}-page-${page + 1}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <><div className="account-section-heading reporting-heading"><h2 className="activity-inspection-title">{displayName}</h2><button className="auth-text-button" disabled={resource.loading} onClick={() => void resource.refresh().catch(() => {})}>{(resource.loading && !resource.data) ? "Refreshing…" : "Refresh"}</button></div><ReportSection title="Resource context"><SettingsRow icon="project" label="Project" value={workspace.projects.find(item => item.id === projectId)?.name ?? projectId} onClick={workspace.activeProjectId !== projectId && workspace.projects.some(item => item.id === projectId) ? () => void mutation.run(async () => { await workspace.switchProject(projectId); }) : undefined} trailing={workspace.activeProjectId === projectId ? <></> : undefined} /><SettingsRow icon="globe" label="Environment" value={rooms.projectId === projectId ? rooms.environments.find(item => item.id === environmentId)?.name ?? environmentId : environmentId} trailing={<></>} />{view === "rooms" && <SettingsRow icon="rooms" label="Room Overview" href={roomOverviewPath(resourceId)} />}{view === "streams" && <SettingsRow icon="streams" label="Stream Overview" href={streamOverviewPath(resourceId)} />}{typeof record.streamId === "string" && <SettingsRow icon="streams" label="Source stream" href={streamOverviewPath(record.streamId)} />}</ReportSection><FormFeedback error={mutation.error} /><ReportSection title="Resource details"><div className="activity-record"><InspectionFields record={record} context={context} /></div></ReportSection>
    {groups.map(group => <section className="settings-section" key={group.title}><h2>{group.title}</h2><div className="developer-attempts">{group.rows.length ? group.rows.map((row, index) => <details className="developer-attempt" key={`${String(row.id ?? row["Guest ID"] ?? row["Mixer ID"] ?? "row")}:${index}`}><summary><span>{entryTitle(row, index)}</span><span>{String(row.state ?? row.State ?? row.status ?? "")}</span></summary><div className="media-output-body"><InspectionFields record={row} context={context} /></div></details>) : <PanelMessage className="media-panel-note">No records on this page.</PanelMessage>}</div>{group.hasNext && <p className="account-section-note">More records are available on the next page.</p>}</section>)}
    <div className="account-pagination"><button type="button" disabled={page === 0 || resource.loading} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page <AnimatedValue value={page + 1} /></span><button type="button" disabled={!data.hasNext || resource.loading || page >= 1000} onClick={() => setPage(value => value + 1)}>Next</button></div><p className="account-section-note">Observed {reportTimestamp(data.observedAt)} UTC. Each history section uses the same page number.</p><Button icon="download" className="workspace-section-button" onClick={() => void exportDetails()}>Export this page</Button></>;
}
function entryTitle(record: InspectionRecord, index: number) { return String(record.name ?? record.Name ?? record["Schedule ID"] ?? record["Destination ID"] ?? record.id ?? record["Scene ID"] ?? record["Window ID"] ?? record["Mixer ID"] ?? `Record ${index + 1}`); }
function InspectionFields({ record, context }: { record: InspectionRecord; context: { projectId: string; environmentId: string } }) {
  return <dl className="account-detail-list">{Object.entries(record).map(([key, value]) => {
    const label = key.includes(" ") ? key : key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, character => character.toUpperCase());
    const linkedView: ActivityView | null = ["Room ID", "roomId"].includes(key) ? "rooms" : ["Source stream ID", "streamId"].includes(key) ? "streams" : ["Source recording ID", "Buffer recording ID"].includes(key) ? "assets" : null;
    const timestamp = typeof value === "string" && /At$|Created|Started|Ended|Expires|Activated|Updated|Scheduled|Actual|Next attempt|Source deadline|Last joined|Last event/.test(key) && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value));
    const text = value === null ? "—" : typeof value === "boolean" ? value ? "Yes" : "No" : typeof value === "number" ? formatMetric(value) : timestamp ? formatRoomTime(value) : value;
    return <div key={key}><dt>{label}</dt><dd>{linkedView && typeof value === "string" ? <Link href={activityHref(context.projectId, context.environmentId, linkedView, value)}>{text}</Link> : typeof value === "number" ? <AnimatedValue value={text} /> : text}</dd></div>;
  })}</dl>;
}
