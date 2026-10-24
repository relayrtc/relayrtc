"use client";

import { PanelMessage } from "@/ui/panel-message";
import { Select } from "@/ui/select";

import { useState } from "react";
import type { ServiceUsage } from "@/lib/reporting-types";
import { reportingCsv, reportPeriod, chartLabel, reportTimestamp } from "@/lib/reporting-api";
import { formatMetric } from "@/lib/rtc-reports";
import { formatBytes, formatTimecode, streamOverviewPath } from "@/lib/streams";
import { downloadCsv, ReportSection, ReportMetric } from "@/ui/report-controls";
import { Field } from "@/ui/auth-fields";
import { SettingsRow } from "@/ui/settings-row";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { LineChart } from "@/ui/line-chart";
import { EmptyState } from "@/ui/empty-state";

const categories: Record<string, string> = { sources: "Source processing", broadcasts: "Outputs & reservations", viewers: "Live delivery & viewers", recordings: "Recordings", clips: "Clips", dvr: "DVR & shared buffers", mixers: "Mixers", "external-sources": "External sources" };
const metricLabels: Record<string, string> = { sourceSeconds: "Source program", sourceEncodeSeconds: "Encoded media", sourceRemuxSeconds: "Remuxed media", sourceComposeFrames: "Composed frames", roomExportBytes: "Room export hop", externalIngressBytes: "Publisher ingress", programBytes: "Encoder program hop", outputSeconds: "Successful output", outputReservationSeconds: "Reserved output capacity", externalOutputBytes: "External output transfer", externalTranscodeSeconds: "Transcoded output", viewerSeconds: "Estimated viewer activity", peakConcurrentViewers: "Peak active viewers", liveDeliveryBytes: "Live origin delivery", abortedDeliveryBytes: "Incomplete response attempts", recordingDeliveryBytes: "Recording delivery", clipDeliveryBytes: "Clip delivery", dvrDeliveryBytes: "DVR delivery", recordingProcessingSeconds: "Recording processing", clipProcessingSeconds: "Clip processing", recordingFinalizations: "Recording finalizations", clipFinalizations: "Clip finalizations", mixerRenderSeconds: "Mixer render time", mixerProgramSeconds: "Healthy mixer program", mixerInputSeconds: "Fresh mixer input", mixerFrames: "Mixer frames", externalFetchBytes: "Upstream fetched", externalProcessingSeconds: "External worker time", recordingStoredBytes: "Recording storage", clipStoredBytes: "Clip storage", bufferStoredBytes: "Shared buffer storage", recordingStorageByteSeconds: "Recording storage time", clipStorageByteSeconds: "Clip storage time", bufferStorageByteSeconds: "Buffer storage time" };
function quantity(value: number | undefined, unit: string) {
  if (value === undefined || !Number.isFinite(value)) return "No measurement";
  return unit === "bytes" ? formatBytes(value) : unit === "seconds" ? formatTimecode(value) : unit === "byte-seconds" ? `${formatMetric(value / (1073741824 * 3600))} GiB-hours` : formatMetric(value);
}
export function ServiceUsagePanel({ data }: { data?: ServiceUsage }) {
  const [category, setCategory] = useState("sources"), [resourceKey, setResourceKey] = useState(""), [projectId, setProjectId] = useState(""), [selected, setSelected] = useState<string | null>(null);
  if (!data) return <ReportSection title="Streaming & assets"><PanelMessage className="media-panel-note">Streaming usage measurements are unavailable.</PanelMessage></ReportSection>;
  const resource = data.resources.find(item => `${item.resourceType}:${item.resourceId}` === resourceKey);
  const project = data.projects.find(item => item.projectId === projectId);
  const metrics = resource?.metrics ?? project?.metrics ?? data.summary, coverage = resource?.metricCoverage ?? project?.metricCoverage ?? data.coverage;
  const definition = selected ? data.metricDefinitions[selected] : null;
  const entries = Object.entries(data.metricDefinitions);
  const categoryEntries = entries.filter(([, value]) => value.category === category);
  const chartScale = definition?.unit === "bytes" ? { unit: "GB", divisor: 1e9 } : definition?.unit === "byte-seconds" ? { unit: "GiB-hours", divisor: 1073741824 * 3600 } : definition?.unit === "seconds" ? { unit: "minutes", divisor: 60 } : { unit: definition?.unit ?? "", divisor: 1 };
  function exportUsage() {
    if (!data) return;
    downloadCsv(reportingCsv(["started_at", "ended_at", "scope", "resource_type", "resource_id", "metric", "quantity", "unit", "coverage", "pricing"], entries.map(([key, value]) => [data.window.startedAt, data.window.endedAt, resource ? "resource" : project ? "project" : "all", resource?.resourceType ?? (project ? "project" : "all"), resource?.resourceId ?? project?.projectId ?? "all", key, coverage[key] === "unavailable" ? null : metrics[key], value.unit, coverage[key] ?? "unavailable", value.pricing])), "relayrtc-streaming-usage.csv");
  }
  return <>
    <section className="settings-section"><h2>Streaming & assets</h2><div className="panel account-filter-form"><Field label="Category"><Select className="input" value={category} onChange={event => setCategory(event.target.value)}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field><Field label="Resource"><Select className="input" value={resource ? resourceKey : ""} onChange={event => { setResourceKey(event.target.value); setProjectId(""); }}><option value="">All resources</option>{data.resources.map(item => <option key={`${item.resourceType}:${item.resourceId}`} value={`${item.resourceType}:${item.resourceId}`}>{item.resourceType} · {item.resourceId}</option>)}</Select></Field>{data.projects.length > 1 && <Field label="Project"><Select className="input" value={project?.projectId ?? ""} onChange={event => { setProjectId(event.target.value); setResourceKey(""); }}><option value="">All projects</option>{data.projects.map(item => <option key={item.projectId} value={item.projectId}>{item.projectId}</option>)}</Select></Field>}</div></section>
    <div className="panel reporting-metric-list">{categoryEntries.map(([key, value]) => <SettingsRow key={key} icon={value.unit === "bytes" || value.unit === "byte-seconds" ? "usage" : "history"} label={metricLabels[key] ?? key} value={coverage[key] === "unavailable" ? "No measurement" : quantity(metrics[key], value.unit)} onClick={() => setSelected(key)} />)}{!categoryEntries.length && <EmptyState compact icon="usage" title="No measurements yet" description="Usage for this category will appear when your application starts sending media." />}</div>
    <p className="account-section-note">{data.historicalCoverage === "partial" ? "Historical coverage is partial. " : ""}Measurements are unpriced. Viewer activity is estimated; delivery measures origin responses. These quantities do not represent charges.</p>
    {data.resourcesTruncated && <p className="account-section-note">Resource breakdown is limited to {data.resourceLimit} resources. Totals include the full selected scope.</p>}
    {resource && <div className="panel workspace-section-button"><SettingsRow icon="streams" label="View Stream" href={streamOverviewPath(resource.streamId)} /></div>}
    <Button icon="download" className="workspace-section-button" onClick={exportUsage}>Export streaming usage</Button>
    <details className="media-section-details"><summary>Measurement rules</summary><dl className="account-detail-list">{Object.entries(data.rules).map(([key, value]) => <div key={key}><dt>{key[0].toUpperCase() + key.slice(1)}</dt><dd>{value}</dd></div>)}</dl></details>
    <Dialog open={Boolean(selected && definition)} title={selected ? metricLabels[selected] ?? selected : "Measurement"} description={reportPeriod(data.window)} onClose={() => setSelected(null)}>{selected && definition && <div className="developer-dialog-stack"><div className="report-dialog-values"><ReportMetric icon="usage" label="Quantity" value={coverage[selected] === "unavailable" ? "No measurement" : quantity(metrics[selected], definition.unit)} /><ReportMetric icon="info" label="Coverage" value={coverage[selected] ?? "unavailable"} /><ReportMetric icon="history" label="Aggregation" value={definition.aggregation} /><ReportMetric icon="usage" label="Pricing" value={definition.pricing} /></div><p className="account-note">{definition.definition}</p><p className="account-note">Source: {definition.source}</p>{!resource && !project && <LineChart title={metricLabels[selected] ?? selected} labels={data.buckets.map(item => chartLabel(item.startedAt, data.window.granularity === "hour" ? "24h" : "7d"))} fullLabels={data.buckets.map(item => `${reportTimestamp(item.startedAt)} UTC`)} unit={chartScale.unit} series={[{ label: metricLabels[selected] ?? selected, color: "orange", values: data.buckets.map(item => coverage[selected] === "unavailable" || item.endedAt <= data.journalStartedAt ? null : (item.metrics[selected] === undefined ? null : item.metrics[selected] / chartScale.divisor)) }]} />}<Button onClick={() => setSelected(null)}>Done</Button></div>}</Dialog>
  </>;
}
