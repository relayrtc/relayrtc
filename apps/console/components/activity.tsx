"use client";

import { Select } from "@/ui/select";
import { PanelMessage } from "@/ui/panel-message";
import { AnimatedValue } from "@/ui/sliding-number";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWorkspace } from "./workspace-provider";
import { useRooms } from "./rooms-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDebouncedValue } from "./use-realtime-refresh";
import { useReportingRefresh } from "./use-reporting-refresh";
import { activityPath, activityHref, reportTimestamp, reportingCsv } from "@/lib/reporting-api";
import type { ActivityPage, ActivityView } from "@/lib/reporting-types";
import { streamStatusLabel } from "@/lib/streams";
import { ReportingNavigation } from "@/ui/reporting-navigation";
import { ReportingState } from "@/ui/reporting-state";
import { Field } from "@/ui/auth-fields";
import { DeveloperEnvironment } from "@/ui/developer-fields";
import { Button } from "@/ui/button";
import { Icon, type IconName } from "@/ui/icon";
import { SettingsRow } from "@/ui/settings-row";
import { ReportSection, downloadCsv } from "@/ui/report-controls";

const views: { value: ActivityView; label: string; icon: IconName }[] = [{ value: "rooms", label: "Rooms", icon: "rooms" }, { value: "streams", label: "Streams", icon: "streams" }, { value: "assets", label: "Assets", icon: "recording" }, { value: "sources", label: "Sources", icon: "ingress" }];
export function Activity() {
  const workspace = useWorkspace(), rooms = useRooms();
  return <section className="content reporting-content" aria-label="Project activity"><ReportingNavigation active="activity" /><DeveloperEnvironment environments={rooms.environments} value={rooms.environmentId} onChange={rooms.setEnvironmentId} disabled={!rooms.ready} />{workspace.project && rooms.ready && rooms.environmentId ? <ActivityList key={`${workspace.project.id}:${rooms.environmentId}`} projectId={workspace.project.id} environmentId={rooms.environmentId} /> : rooms.ready && !rooms.environmentId ? <div className="empty-state"><h2>No active environments</h2><p>Add an environment in your project settings to inspect activity.</p>{workspace.project && <Link className="auth-text-button" href={`/projects/${encodeURIComponent(workspace.project.id)}`}>Project settings</Link>}</div> : <ReportingState error={rooms.error} loading={!rooms.error} label="activity environment" onRetry={() => void rooms.refresh().catch(() => {})} />}</section>;
}
function ActivityList({ projectId, environmentId }: { projectId: string; environmentId: string }) {
  const workspace = useWorkspace();
  const searchParams = useSearchParams();
  const [view, setView] = useState<ActivityView>(() => views.find(item => item.value === searchParams.get("view"))?.value ?? "rooms"), [search, setSearch] = useState(""), [page, setPage] = useState(0), [assetKind, setAssetKind] = useState("all");
  const query = useDebouncedValue(search.trim());
  const parameters = new URLSearchParams({ view, page: String(page), search: query, assetKind });
  const resource = useWorkspaceResource<ActivityPage>(`${activityPath(projectId, environmentId)}?${parameters}`);
  useReportingRefresh(resource.refresh);
  const label = views.find(item => item.value === view)!.label;
  function exportPage() {
    if (!resource.data) return;
    downloadCsv(reportingCsv(["project_id", "environment_id", "view", "id", "name", "detail", "status", "created_at", "observed_at"], resource.data.rows.map(item => [projectId, environmentId, view, item.id, item.label, item.detail, item.status, item.createdAt, resource.data!.observedAt])), `relayrtc-activity-${view}-page-${page + 1}.csv`);
  }
  return <>
    <div className="segmented-control report-range reporting-range" role="group" aria-label="Activity resource">{views.map(item => <button key={item.value} type="button" className={view === item.value ? "segment-active" : ""} aria-pressed={view === item.value} onClick={() => { setView(item.value); setPage(0); setSearch(""); }}>{item.label}</button>)}</div>
    <div className="search-field streams-search"><Icon name="search" size={18.1125} /><input className="input" type="search" aria-label="Search activity" placeholder={view === "assets" ? "Search asset ID or kind" : "Search name or ID"} value={search} maxLength={120} onChange={event => { setSearch(event.target.value); setPage(0); }} /></div>
    {view === "assets" && <div className="panel account-filter-form workspace-section-button"><Field label="Asset kind"><Select className="input" value={assetKind} onChange={event => { setAssetKind(event.target.value); setPage(0); }}><option value="all">All assets</option><option value="recording">Recordings</option><option value="clip">Clips</option><option value="buffer">DVR & clip buffers</option></Select></Field></div>}
    <div className="account-section-heading reporting-heading"><h2>{label}</h2><button className="auth-text-button" disabled={resource.loading} onClick={() => void resource.refresh().catch(() => {})}>{(resource.loading && !resource.data) ? "Refreshing…" : "Refresh"}</button></div>
    {!resource.data ? <ReportingState loading={resource.loading} error={resource.error} label="activity" onRetry={() => void resource.refresh().catch(() => {})} /> : <><div className="panel" aria-busy={resource.loading}>{resource.data.rows.length ? resource.data.rows.map(item => <Link className="account-list-row" href={activityHref(projectId, environmentId, view, item.id)} key={item.id}><span className="account-list-icon"><Icon name={views.find(value => value.value === view)!.icon} size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{item.label || item.id}</span><span className="account-list-description">{item.detail.replaceAll("_", " ")} · {reportTimestamp(item.createdAt)} UTC</span></span><span className={`account-outcome ${["failed", "critical"].includes(item.status) ? "account-outcome-failure" : "developer-badge-muted"}`}>{streamStatusLabel(item.status)}</span></Link>) : <PanelMessage className="media-panel-note">No resources match these filters.</PanelMessage>}</div><div className="account-pagination"><button type="button" disabled={page === 0 || resource.loading} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page <AnimatedValue value={page + 1} /></span><button type="button" disabled={!resource.data.hasNext || resource.loading || page >= 1000} onClick={() => setPage(value => value + 1)}>Next</button></div><p className="account-section-note">Observed {reportTimestamp(resource.data.observedAt)} UTC. Includes retained resource history.</p><Button icon="download" className="workspace-section-button" disabled={!resource.data.rows.length} onClick={exportPage}>Export this page</Button></>}
    <ReportSection title="Security activity">{workspace.organization?.canManage && <SettingsRow icon="organization" label="Organization audit history" href={`/organizations/${encodeURIComponent(workspace.organization.id)}/activity`} />}<SettingsRow icon="shield" label="My security activity" href="/account/activity" /></ReportSection>
  </>;
}
