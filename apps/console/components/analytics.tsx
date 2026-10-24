"use client";

import { AnimatedValue } from "@/ui/sliding-number";
import { PanelMessage } from "@/ui/panel-message";
import { Select } from "@/ui/select";

import { useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { useRooms } from "./rooms-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useReportingRefresh } from "./use-reporting-refresh";
import { ReportingEnvironment, ReportingRange } from "./reporting-filters";
import { ServiceUsagePanel } from "./service-usage-panel";
import { analyticsRanges, chartLabel, projectReportPath, reportPeriod, reportTimestamp, reportingCsv } from "@/lib/reporting-api";
import type { AnalyticsRange, AnalyticsReport } from "@/lib/reporting-types";
import { formatMetric } from "@/lib/rtc-reports";
import { formatBytes, formatTimecode } from "@/lib/streams";
import { roomOverviewPath } from "@/lib/rooms";
import { Button } from "@/ui/button";
import { FormFeedback } from "@/ui/auth-fields";
import { Dialog } from "@/ui/dialog";
import { LineChart } from "@/ui/line-chart";
import { downloadCsv, ExportButton, ReportSection, ReportMetric } from "@/ui/report-controls";
import { SettingsRow } from "@/ui/settings-row";
import { ReportingNavigation } from "@/ui/reporting-navigation";
import { ReportCoverage, ReportingState } from "@/ui/reporting-state";

export function Analytics() {
  const workspace = useWorkspace();
  return <section className="content reporting-content" aria-label="RTC analytics"><ReportingNavigation active="analytics" />{workspace.project && <AnalyticsView key={workspace.project.id} projectId={workspace.project.id} />}</section>;
}
function AnalyticsView({ projectId }: { projectId: string }) {
  const rooms = useRooms();
  const [range, setRange] = useState<AnalyticsRange>("7d"), [environment, setEnvironment] = useState("all");
  const [dialog, setDialog] = useState<"traffic" | "quality" | "connections" | null>(null);
  const [traffic, setTraffic] = useState<"sfu" | "turn">("sfu"), [quality, setQuality] = useState<"roundTripTimeMs" | "jitterMs" | "packetLossPercent">("roundTripTimeMs");
  const validEnvironment = environment === "all" || rooms.environments.some(item => item.id === environment);
  const resource = useWorkspaceResource<AnalyticsReport>(rooms.ready && validEnvironment ? projectReportPath(projectId, "analytics", range, environment) : null);
  useReportingRefresh(resource.refresh, rooms.ready && validEnvironment);
  const data = resource.data;
  const latest = data ? [...data.quality].reverse().find(item => item.sampleCount > 0) : undefined;
  const retry = () => { void rooms.refresh().catch(() => {}); void resource.refresh().catch(() => {}); };
  function exportReport() {
    if (!data) return;
    const rows: (string | number | null)[][] = [
      ...Object.entries(data.summary).map(([metric, value]) => ["summary", data.window.startedAt, data.window.endedAt, metric, value]),
      ...data.networkSeries.flatMap(point => ["sfuIngressBytes", "sfuEgressBytes", "turnIngressBytes", "turnEgressBytes"].map(key => ["network", point.startedAt, point.endedAt, key, key.startsWith("turn") && data.dataQuality.turnTraffic === "unavailable" ? null : point[key as keyof typeof data.network]])),
      ...data.quality.flatMap(point => (["roundTripTimeMs", "jitterMs", "packetLossPercent", "sampleCount"] as const).map(key => ["quality", point.startedAt, point.endedAt, key, point[key]])),
      ...data.traffic.flatMap(point => (["participants", "sessions", "participantSeconds"] as const).map(key => ["traffic", point.startedAt, point.endedAt, key, point[key]])),
      ...data.regions.map(item => ["region", data.window.startedAt, data.window.endedAt, item.name, item.sessions]),
      ...data.qualityDistribution.map(item => ["quality_distribution", data.window.startedAt, data.window.endedAt, item.quality, item.count]),
      ...data.topRooms.flatMap(item => [["room_name", data.window.startedAt, data.window.endedAt, item.id, item.name], ["room_participants", data.window.startedAt, data.window.endedAt, item.id, item.participants], ["room_participant_seconds", data.window.startedAt, data.window.endedAt, item.id, item.participantSeconds]]),
      ...Object.entries(data.dataQuality).map(([key, value]) => ["coverage", data.window.startedAt, data.window.endedAt, key, value]),
    ];
    downloadCsv(reportingCsv(["section", "started_at", "ended_at", "metric", "value"], rows), `relayrtc-analytics-${range}.csv`);
  }
  return <>
    <FormFeedback error={data ? resource.error : ""} />
    <ReportingEnvironment value={environment} onChange={value => { setEnvironment(value); setDialog(null); }} />
    <ReportingRange options={analyticsRanges} value={range} onChange={value => { setRange(value); setDialog(null); }} />
    {range === "live" && <p className="account-section-note">Live shows the last 15 minutes. Reports refresh every second while visible.</p>}
    {!validEnvironment && <ReportingState loading={false} error="This environment is no longer available. Select an active environment." onRetry={() => { setEnvironment("all"); retry(); }} />}
    {!rooms.ready ? <ReportingState error={rooms.error} loading={!rooms.error} onRetry={retry} label="environments" /> : !data ? <ReportingState error={resource.error} loading={resource.loading} onRetry={retry} label="analytics" /> : <>
      <div className="account-section-heading reporting-heading"><p className="account-note">{reportPeriod(data.window)}</p><button className="auth-text-button" disabled={resource.loading && !data} onClick={() => void resource.refresh().catch(() => {})}>{(resource.loading && !resource.data) ? "Refreshing…" : "Refresh"}</button></div>
      <ReportSection title="Media traffic"><ReportMetric label="SFU ingress" value={formatBytes(data.network.sfuIngressBytes)} icon="ingress" /><ReportMetric label="SFU egress" value={formatBytes(data.network.sfuEgressBytes)} icon="egress" /><ReportMetric label="TURN ingress" value={data.dataQuality.turnTraffic === "unavailable" ? "Unavailable" : formatBytes(data.network.turnIngressBytes)} icon="turn" /><ReportMetric label="TURN egress" value={data.dataQuality.turnTraffic === "unavailable" ? "Unavailable" : formatBytes(data.network.turnEgressBytes)} icon="turn" /><SettingsRow icon="analytics" label="Traffic history" onClick={() => setDialog("traffic")} /></ReportSection>
      <ReportSection title="Media quality"><ReportMetric icon="quality" label="Latest RTT" value={formatMetric(latest?.roundTripTimeMs)} unit={latest?.roundTripTimeMs == null ? "" : "ms"} /><ReportMetric icon="quality" label="Latest jitter" value={formatMetric(latest?.jitterMs)} unit={latest?.jitterMs == null ? "" : "ms"} /><ReportMetric icon="quality" label="Latest packet loss" value={formatMetric(latest?.packetLossPercent)} unit={latest?.packetLossPercent == null ? "" : "%"} /><SettingsRow icon="quality" label="Quality history" onClick={() => setDialog("quality")} /></ReportSection>
      <p className="account-section-note"><AnimatedValue value={latest ? `Latest measured bucket: ${reportTimestamp(latest.startedAt)} UTC · ${formatMetric(latest.sampleCount)} samples.` : "No quality measurements are available for this period."} /></p>
      <ReportSection title="Connections"><ReportMetric icon="rooms" label="Sessions" value={formatMetric(data.summary.totalSessions)} /><ReportMetric icon="users" label="Peak concurrent participants" value={formatMetric(data.summary.peakConcurrent)} /><ReportMetric icon="history" label="Participant minutes" value={formatMetric(data.summary.participantSeconds / 60)} /><ReportMetric icon="calendar" label="Average session" value={data.summary.totalSessions ? formatTimecode(data.summary.averageSessionSeconds) : "No sessions"} /><ReportMetric icon="quality" label="Connection success" value={data.summary.totalSessions ? `${formatMetric(data.summary.connectionSuccessRate)}%` : "No sessions"} /><SettingsRow icon="analytics" label="Connection history" onClick={() => setDialog("connections")} /><SettingsRow icon="signaling" label="Signaling usage" href="/usage" /></ReportSection>
      <ReportSection title="Quality distribution">{data.qualityDistribution.length ? data.qualityDistribution.map(item => <ReportMetric icon="quality" label={item.quality[0].toUpperCase() + item.quality.slice(1)} value={formatMetric(item.count)} key={item.quality} />) : <PanelMessage className="media-panel-note">No quality observations.</PanelMessage>}</ReportSection>
      <ReportSection title="Regional sessions">{data.regions.length ? data.regions.map(item => <ReportMetric icon="globe" key={item.name} label={item.name} value={formatMetric(item.sessions)} unit="sessions" />) : <PanelMessage className="media-panel-note">No regional session observations.</PanelMessage>}</ReportSection>
      <ReportSection title="Top rooms">{data.topRooms.length ? data.topRooms.map(item => <SettingsRow key={item.id} icon="rooms" label={item.name || item.id} value={`${formatMetric(item.participantSeconds / 60)} min`} href={roomOverviewPath(item.id)} />) : <PanelMessage className="media-panel-note">No room activity for this period.</PanelMessage>}</ReportSection>
      <ReportCoverage quality={data.dataQuality} /><ExportButton onClick={exportReport} />
      <ServiceUsagePanel data={data.serviceUsage} />
      <Dialog open={Boolean(dialog)} title={dialog === "traffic" ? "Traffic history" : dialog === "connections" ? "Connection history" : "Quality history"} description={reportPeriod(data.window)} onClose={() => setDialog(null)}>
        <div className="developer-dialog-stack">
          {dialog === "traffic" && <><div className="segmented-control traffic-tabs" role="group" aria-label="Traffic service">{(["sfu", "turn"] as const).map(value => <button type="button" key={value} aria-pressed={traffic === value} className={traffic === value ? "segment-active" : ""} onClick={() => setTraffic(value)}>{value.toUpperCase()}</button>)}</div><LineChart key={`${range}-${traffic}`} title={`${traffic.toUpperCase()} traffic`} labels={data.networkSeries.map(point => chartLabel(point.startedAt, range))} fullLabels={data.networkSeries.map(point => `${reportTimestamp(point.startedAt)} UTC`)} unit="GB" series={[{ label: "Egress", color: "orange", values: data.networkSeries.map(point => traffic === "sfu" ? point.sfuEgressBytes / 1e9 : data.dataQuality.turnTraffic === "unavailable" ? null : point.turnEgressBytes / 1e9) }, { label: "Ingress", color: "gray", values: data.networkSeries.map(point => traffic === "sfu" ? point.sfuIngressBytes / 1e9 : data.dataQuality.turnTraffic === "unavailable" ? null : point.turnIngressBytes / 1e9) }]} /></>}
          {dialog === "connections" && <LineChart title="Connections" labels={data.traffic.map(point => chartLabel(point.startedAt, range))} fullLabels={data.traffic.map(point => `${reportTimestamp(point.startedAt)} UTC`)} unit="" series={[{ label: "Peak participants", color: "orange", values: data.traffic.map(point => point.participants) }, { label: "Sessions", color: "gray", values: data.traffic.map(point => point.sessions) }]} />}
          {dialog === "quality" && <><label className="account-field"><span className="field-label">Quality metric</span><Select className="input" value={quality} onChange={event => setQuality(event.target.value as typeof quality)}><option value="roundTripTimeMs">Round-trip time</option><option value="jitterMs">Jitter</option><option value="packetLossPercent">Packet loss</option></Select></label><LineChart key={quality} title="Media quality" labels={data.quality.map(point => chartLabel(point.startedAt, range))} fullLabels={data.quality.map(point => `${reportTimestamp(point.startedAt)} UTC`)} unit={quality === "packetLossPercent" ? "%" : "ms"} series={[{ label: quality === "roundTripTimeMs" ? "RTT" : quality === "jitterMs" ? "Jitter" : "Packet loss", color: "orange", values: data.quality.map(point => point[quality]) }]} /><p className="account-note">Gaps indicate missing measurements. Quality is sampled at a one-minute granularity.</p></>}
          <Button onClick={() => setDialog(null)}>Done</Button>
        </div>
      </Dialog>
    </>}
  </>;
}
