"use client";

import { PanelMessage } from "@/ui/panel-message";
import { AnimatedValue } from "@/ui/sliding-number";
import { Select } from "@/ui/select";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWorkspace } from "./workspace-provider";
import { useRooms } from "./rooms-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useReportingRefresh } from "./use-reporting-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { ReportingEnvironment, ReportingRange } from "./reporting-filters";
import { ServiceUsagePanel } from "./service-usage-panel";
import { usageRanges, chartLabel, projectReportPath, organizationReportPath, reportPeriod, reportTimestamp, reportingCsv } from "@/lib/reporting-api";
import type { UsageRange, ProjectUsage, OrganizationUsage, OrganizationQuota, UsageSummary, ReportQuality } from "@/lib/reporting-types";
import { formatMetric } from "@/lib/rtc-reports";
import { formatBytes } from "@/lib/streams";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { EmptyState } from "@/ui/empty-state";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { LineChart } from "@/ui/line-chart";
import { downloadCsv, ExportButton, ReportMetric, ReportSection } from "@/ui/report-controls";
import { SettingsRow } from "@/ui/settings-row";
import { ReportingNavigation } from "@/ui/reporting-navigation";
import { ReportCoverage, ReportingState } from "@/ui/reporting-state";

export function Usage() {
  const workspace = useWorkspace();
  return <section className="content reporting-content" aria-label="Usage"><ReportingNavigation active="usage" />{workspace.organization && workspace.project && <UsageScope key={workspace.organization.id} organizationId={workspace.organization.id} projectId={workspace.project.id} />}</section>;
}
function UsageScope({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  const searchParams = useSearchParams();
  const [scope, setScope] = useState<"project" | "organization">(() => searchParams.get("scope") === "organization" ? "organization" : "project");
  return <><div className="segmented-control report-range reporting-scope" role="group" aria-label="Usage scope">{(["project", "organization"] as const).map(value => <button type="button" key={value} className={scope === value ? "segment-active" : ""} aria-pressed={scope === value} onClick={() => setScope(value)}>{value === "project" ? "Project usage" : "Organization usage"}</button>)}</div><UsageView key={`${scope}:${projectId}`} projectId={projectId} organizationId={organizationId} scope={scope} onProject={() => setScope("project")} /></>;
}
function UsageView({ organizationId, projectId, scope, onProject }: { organizationId: string; projectId: string; scope: "project" | "organization"; onProject: () => void }) {
  const workspace = useWorkspace(), rooms = useRooms(), mutation = useDeveloperMutation();
  const [range, setRange] = useState<UsageRange>("7d"), [environment, setEnvironment] = useState("all"), [page, setPage] = useState(0);
  const [dialog, setDialog] = useState<"quota" | "history" | null>(null), [history, setHistory] = useState<"participantSeconds" | "roomsCreated">("participantSeconds");
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const validEnvironment = environment === "all" || rooms.environments.some(item => item.id === environment);
  const ready = scope === "organization" || rooms.ready && validEnvironment;
  const resource = useWorkspaceResource<ProjectUsage | OrganizationUsage>(ready ? scope === "project" ? projectReportPath(projectId, "usage", range, environment) : organizationReportPath(organizationId, range, page) : null);
  const quota = useWorkspaceResource<OrganizationQuota>(`/api/reporting/organizations/${encodeURIComponent(organizationId)}/quota`);
  useReportingRefresh(resource.refresh, ready);
  const data = resource.data, project = data && "scope" in data ? data : null, organization = data && "projects" in data ? data : null;
  const selected = organization?.projects.find(item => item.projectId === selectedProject);
  const retry = () => { void rooms.refresh().catch(() => {}); void resource.refresh().catch(() => {}); void quota.refresh().catch(() => {}); };
  function exportReport() {
    if (!data) return;
    const rows: (string | number | null)[][] = [
      ...Object.entries(data.summary).map(([key, value]) => ["summary", data.window.startedAt, data.window.endedAt, scope === "project" ? projectId : organizationId, key, key.startsWith("turn") && data.dataQuality.turnTraffic === "unavailable" ? null : value]),
      ...Object.entries(data.dataQuality).map(([key, value]) => ["coverage", data.window.startedAt, data.window.endedAt, scope === "project" ? projectId : organizationId, key, value]),
      ...(project?.buckets.flatMap(bucket => (["participantSeconds", "roomsCreated"] as const).map(key => ["bucket", bucket.startedAt, bucket.endedAt, projectId, key, bucket[key]])) ?? []),
      ...(organization?.projects.flatMap(item => Object.entries(item.summary).map(([key, value]) => ["project", data.window.startedAt, data.window.endedAt, item.projectId, key, key.startsWith("turn") && item.dataQuality.turnTraffic === "unavailable" ? null : value])) ?? []),
    ];
    downloadCsv(reportingCsv(["section", "started_at", "ended_at", "scope_id", "metric", "quantity"], rows), `relayrtc-${scope}-usage-${range}${scope === "organization" ? `-page-${page + 1}` : ""}.csv`);
  }
  return <>
    {scope === "project" && <ReportingEnvironment value={environment} onChange={setEnvironment} />}
    <FormFeedback error={data ? resource.error : ""} />
    <ReportingRange options={usageRanges} value={range} onChange={value => { setRange(value); setPage(0); setDialog(null); setSelectedProject(null); }} />
    {!validEnvironment && scope === "project" && <ReportingState loading={false} error="This environment is no longer available. Select another environment." onRetry={() => { setEnvironment("all"); retry(); }} />}
    {!ready ? <ReportingState error={rooms.error} loading={!rooms.error && validEnvironment} onRetry={retry} label="environments" /> : !data ? <ReportingState error={resource.error} loading={resource.loading} onRetry={retry} label="usage" /> : <>
      <div className="account-section-heading reporting-heading"><p className="account-note">{reportPeriod(data.window)}</p><button className="auth-text-button" disabled={resource.loading && !data} onClick={() => void resource.refresh().catch(() => {})}>{(resource.loading && !resource.data) ? "Refreshing…" : "Refresh"}</button></div>
      <ReportSection title="Plan limits"><SettingsRow icon="usage" label="Organization quota" value={quota.data?.status === "unconfigured" ? "Unconfigured" : quota.error ? "Unavailable" : "Loading…"} onClick={() => setDialog("quota")} /></ReportSection>
      <p className="account-section-note">Usage is measured for the selected rolling period. {quota.data ? "Organization quotas are unconfigured. These measurements are unpriced." : "Quota information is unavailable. These measurements do not include pricing."}</p><FormFeedback error={quota.error} />
      <UsageTotals summary={data.summary} quality={data.dataQuality} />
      {project && <div className="panel workspace-section-button"><SettingsRow icon="analytics" label="Usage history" onClick={() => setDialog("history")} /></div>}
      {organization && <><ReportSection title="Projects">{organization.projects.length ? organization.projects.map(item => <SettingsRow key={item.projectId} icon="project" label={workspace.projects.find(value => value.id === item.projectId)?.name ?? item.projectId} value={`${formatMetric(item.summary.participantSeconds / 60)} min`} onClick={() => setSelectedProject(item.projectId)} />) : <PanelMessage className="media-panel-note">No projects on this page.</PanelMessage>}</ReportSection><div className="account-pagination"><button type="button" disabled={page === 0 || resource.loading} onClick={() => { setSelectedProject(null); setPage(value => value - 1); }}>Previous</button><span>Page <AnimatedValue value={page + 1} /></span><button type="button" disabled={resource.loading || organization.pagination.offset + organization.pagination.limit >= organization.pagination.total || (page + 1) * 30 > 100000} onClick={() => { setSelectedProject(null); setPage(value => value + 1); }}>Next</button></div><p className="account-section-note">Organization totals cover all projects. The project breakdown and CSV include the current page.</p></>}
      <ReportCoverage quality={data.dataQuality} /><ExportButton onClick={exportReport} /><ServiceUsagePanel data={data.serviceUsage} />
      <Dialog open={Boolean(dialog)} title={dialog === "quota" ? "Organization limits" : "Usage history"} description={dialog === "history" ? reportPeriod(data.window) : undefined} onClose={() => setDialog(null)}><div className="developer-dialog-stack">{dialog === "quota" ? <><EmptyState compact icon="usage" title={quota.data?.status === "unconfigured" ? "No plan limits configured" : "Plan limits unavailable"} description={quota.data?.status === "unconfigured" ? "This organization has no configured usage quotas. Included allowances, reset dates, and billed amounts are not available." : "Try refreshing to load your organization limits."} /><FormFeedback error={quota.error} /><p className="account-note">Streaming capacity and operation limits are still enforced by their services. These usage measurements are unpriced.</p>{quota.error && <Button onClick={() => void quota.refresh().catch(() => {})}>Reload quota</Button>}</> : project && <><Field label="Metric"><Select className="input" value={history} onChange={event => setHistory(event.target.value as typeof history)}><option value="participantSeconds">Participant minutes</option><option value="roomsCreated">Rooms created</option></Select></Field><LineChart key={history} title={history === "participantSeconds" ? "Participant minutes" : "Rooms created"} labels={project.buckets.map(item => chartLabel(item.startedAt, range))} fullLabels={project.buckets.map(item => `${reportTimestamp(item.startedAt)} UTC`)} unit={history === "participantSeconds" ? "minutes" : "rooms"} series={[{ label: history === "participantSeconds" ? "Participant minutes" : "Rooms created", color: "orange", values: project.buckets.map(item => history === "participantSeconds" ? item.participantSeconds / 60 : item.roomsCreated) }]} /></>}<Button onClick={() => setDialog(null)}>Done</Button></div></Dialog>
      <Dialog open={Boolean(selected)} title={selected ? workspace.projects.find(item => item.id === selected.projectId)?.name ?? "Project usage" : "Project usage"} description={reportPeriod(data.window)} onClose={() => setSelectedProject(null)}>{selected && <div className="developer-dialog-stack"><UsageTotals summary={selected.summary} quality={selected.dataQuality} /><ReportCoverage quality={selected.dataQuality} /><FormFeedback error={mutation.error} />{workspace.projects.some(item => item.id === selected.projectId && item.status === "active") && <Button disabled={mutation.pending} variant="primary" onClick={() => void mutation.run(async () => { await workspace.switchProject(selected.projectId); onProject(); })}>{mutation.pending ? "Selecting…" : "View project usage"}</Button>}<Button disabled={mutation.pending} onClick={() => setSelectedProject(null)}>Done</Button></div>}</Dialog>
    </>}
  </>;
}
export function UsageTotals({ summary, quality }: { summary: UsageSummary; quality: ReportQuality }) {
  return <>
    <ReportSection title="Participants & rooms"><ReportMetric icon="users" label="Participant minutes" value={formatMetric(summary.participantSeconds / 60)} /><ReportMetric icon="users" label="Peak participants" value={formatMetric(summary.peakConcurrentParticipants)} /><ReportMetric icon="users" label="Average concurrent participants" value={formatMetric(summary.averageConcurrentParticipants)} /><ReportMetric icon="rooms" label="Rooms created" value={formatMetric(summary.roomsCreated)} /><ReportMetric icon="rooms" label="Rooms started" value={formatMetric(summary.roomsStarted)} /><ReportMetric icon="rooms" label="Peak rooms" value={formatMetric(summary.peakConcurrentRooms)} /><ReportMetric icon="calendar" label="Room minutes" value={formatMetric(summary.roomSeconds / 60)} /></ReportSection>
    <ReportSection title="Media usage"><ReportMetric icon="recording" label="Audio participant minutes" value={formatMetric(summary.audioParticipantSeconds / 60)} /><ReportMetric icon="recording" label="Video participant minutes" value={formatMetric(summary.videoParticipantSeconds / 60)} /><ReportMetric icon="recording" label="Screen sharing minutes" value={formatMetric(summary.screenShareSeconds / 60)} /><ReportMetric icon="ingress" label="Screen sharing ingress" value={formatBytes(summary.screenShareIngressBytes)} /><ReportMetric icon="egress" label="Screen sharing egress" value={formatBytes(summary.screenShareEgressBytes)} /><ReportMetric icon="ingress" label="SFU ingress" value={formatBytes(summary.sfuIngressBytes)} /><ReportMetric icon="egress" label="SFU egress" value={formatBytes(summary.sfuEgressBytes)} /><ReportMetric icon="turn" label="TURN ingress" value={quality.turnTraffic === "unavailable" ? "Unavailable" : formatBytes(summary.turnIngressBytes)} /><ReportMetric icon="turn" label="TURN egress" value={quality.turnTraffic === "unavailable" ? "Unavailable" : formatBytes(summary.turnEgressBytes)} /><ReportMetric icon="turn" label="TURN relay minutes" value={quality.turnTraffic === "unavailable" ? "Unavailable" : formatMetric(summary.turnRelaySeconds / 60)} /><ReportMetric icon="turn" label="TURN sessions" value={quality.turnTraffic === "unavailable" ? "Unavailable" : formatMetric(summary.turnSessions)} /></ReportSection>
    <ReportSection title="Signaling"><ReportMetric icon="signaling" label="Connections" value={formatMetric(summary.signalingConnections)} /><ReportMetric icon="history" label="Connection minutes" value={formatMetric(summary.signalingConnectionSeconds / 60)} /><ReportMetric icon="signaling" label="Messages In" value={formatMetric(summary.messagesIn)} /><ReportMetric icon="signaling" label="Messages Out" value={formatMetric(summary.messagesOut)} /><SettingsRow icon="analytics" label="View Analytics" href="/analytics" /></ReportSection>
  </>;
}
