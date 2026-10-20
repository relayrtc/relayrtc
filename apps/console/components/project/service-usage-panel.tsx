"use client";

import { useState } from "react";
import type { ServiceUsageReport } from "@relayrtc/validation";
import { serviceUsageDefinitions } from "@relayrtc/types";
import { Panel } from "@/components/page/panel";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDuration, formatNumber } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";

const categories = [
  "sources",
  "broadcasts",
  "viewers",
  "recordings",
  "clips",
  "dvr",
  "mixers",
  "external-sources",
] as const;
const names = {
  sources: "Source processing",
  broadcasts: "Outputs and reservations",
  viewers: "Live delivery and viewer activity",
  recordings: "Recordings",
  clips: "Clips",
  dvr: "DVR and shared buffers",
  mixers: "Mixers",
  "external-sources": "External sources",
};
const labels: Record<string, string> = {
  sourceSeconds: "Source program",
  sourceEncodeSeconds: "Encoded media",
  sourceRemuxSeconds: "Remuxed media",
  sourceComposeFrames: "Composed frames",
  roomExportBytes: "Room export hop",
  externalIngressBytes: "External publisher ingress",
  programBytes: "Encoder program hop",
  outputSeconds: "Successful output",
  outputReservationSeconds: "Reserved output capacity",
  externalOutputBytes: "External output transfer",
  externalTranscodeSeconds: "Transcoded output",
  viewerSeconds: "Estimated viewer activity",
  peakConcurrentViewers: "Peak active viewers",
  liveDeliveryBytes: "Live origin delivery",
  abortedDeliveryBytes: "Incomplete response attempts",
  recordingDeliveryBytes: "Origin delivery",
  clipDeliveryBytes: "Origin delivery",
  dvrDeliveryBytes: "Origin delivery",
  recordingProcessingSeconds: "Attempted finalization",
  clipProcessingSeconds: "Attempted finalization",
  recordingFinalizations: "Successful finalizations",
  clipFinalizations: "Successful finalizations",
  mixerRenderSeconds: "Render attempts",
  mixerProgramSeconds: "Healthy applied program",
  mixerInputSeconds: "Fresh input activity",
  mixerFrames: "Submitted frames",
  externalFetchBytes: "Upstream fetched",
  externalProcessingSeconds: "Worker processing",
  recordingStoredBytes: "Retained at window end",
  clipStoredBytes: "Retained at window end",
  bufferStoredBytes: "Retained at window end",
  recordingStorageByteSeconds: "Retained storage time",
  clipStorageByteSeconds: "Retained storage time",
  bufferStorageByteSeconds: "Retained storage time",
};
const quantity = (value: number, unit: string) =>
  unit === "bytes"
    ? formatBytes(value, 2)
    : unit === "seconds"
      ? formatDuration(value)
      : unit === "byte-seconds"
        ? `${(value / (1073741824 * 3600)).toLocaleString(undefined, { maximumSignificantDigits: 4 })} GiB-hours`
        : formatNumber(value);

export function ServiceUsagePanel({ data }: { data: ServiceUsageReport | undefined }) {
  const [resourceId, setResourceId] = useState("");
  const [projectId, setProjectId] = useState("");
  if (!data) return null;
  const resource = data.resources.find((r) => `${r.resourceType}:${r.resourceId}` === resourceId);
  const project = data.projects.find((p) => p.projectId === projectId);
  const metrics = resource?.metrics ?? project?.metrics ?? data.summary;
  const metricCoverage = resource?.metricCoverage ?? project?.metricCoverage ?? data.coverage;
  const entries = Object.entries(serviceUsageDefinitions);
  const exportUsage = () =>
    downloadCsv(
      "streaming-usage.csv",
      [
        "started_at",
        "ended_at",
        "resource_type",
        "resource_id",
        "metric",
        "quantity",
        "unit",
        "coverage",
        "pricing",
      ],
      entries.map(([name, definition]) => [
        data.window.startedAt,
        data.window.endedAt,
        resource?.resourceType ?? (project ? "project" : "all"),
        resource?.resourceId ?? project?.projectId ?? "all",
        name,
        metrics[name] ?? 0,
        definition.unit,
        metricCoverage[name] ?? "unavailable",
        "unpriced",
      ]),
    );
  return (
    <section className="flex flex-col gap-4" aria-label="Streaming and asset usage">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-normal tracking-tight">Streaming and assets</h2>
        <Button variant="outline" size="sm" onClick={exportUsage}>
          Export usage
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Same selected UTC window as room usage. Delivery is measured at our origin; viewer activity
        estimates recent media requests. These are usage quantities, with no price conversion
        applied.
      </p>
      {data.projects.length > 1 && (
        <label className="flex flex-col gap-2 text-sm sm:max-w-xl">
          Project
          <select
            className="h-9 rounded-md border bg-background px-3"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setResourceId("");
            }}
          >
            <option value="">All projects</option>
            {data.projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectId}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-xs text-muted-foreground">
        {data.window.startedAt} to {data.window.endedAt} (UTC, end exclusive)
      </p>
      <label className="flex flex-col gap-2 text-sm sm:max-w-xl">
        Resource
        <select
          className="h-9 rounded-md border bg-background px-3"
          value={resourceId}
          onChange={(e) => {
            setResourceId(e.target.value);
            setProjectId("");
          }}
        >
          <option value="">All resources in this scope</option>
          {data.resources.map((r) => (
            <option
              key={`${r.resourceType}:${r.resourceId}`}
              value={`${r.resourceType}:${r.resourceId}`}
            >
              {r.resourceType}: {r.resourceId}
            </option>
          ))}
        </select>
      </label>
      {resource && (
        <p className="break-all text-xs text-muted-foreground">
          Stream: {resource.streamId}. Resource figures use the same window and units as the totals.
        </p>
      )}
      {data.resourcesTruncated && (
        <p className="text-xs text-muted-foreground">
          Showing the first 100 resource drilldowns. Scope totals include every resource; use an
          individual resource usage report for other resources.
        </p>
      )}
      {data.historicalCoverage === "partial" && (
        <p role="status" className="text-sm text-muted-foreground">
          Streaming measurements started {new Date(data.journalStartedAt).toLocaleString()}. Earlier
          activity is unavailable and has not been reconstructed from lifetime counters.
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {categories.map((category) => (
          <Panel key={category}>
            <h3 className="mb-3 text-base font-medium">{names[category]}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2 font-normal">Metric</th>
                  <th className="pb-2 text-right font-normal">Usage</th>
                  <th className="pb-2 text-right font-normal">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {entries
                  .filter(([, d]) => d.category === category)
                  .map(([name, d]) => {
                    const coverage = metricCoverage[name] ?? "unavailable";
                    return (
                      <tr key={name} className="border-t">
                        <td className="py-2 pr-3" title={d.definition}>
                          {labels[name] ?? name}
                        </td>
                        <td
                          className="py-2 text-right tabular-nums"
                          title={`${metrics[name] ?? 0} ${d.unit}. ${d.definition}`}
                        >
                          {coverage === "unavailable"
                            ? "Unavailable"
                            : quantity(metrics[name] ?? 0, d.unit)}
                        </td>
                        <td className="py-2 pl-3 text-right text-xs text-muted-foreground">
                          {coverage}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        SFU, TURN, room export, encoder program and external output are separate service hops and
        can contain the same media. Avoid adding them together as unique traffic. Storage counts
        physical recording, clip and shared buffer objects once; origin caches and pending uploads
        are excluded.
      </p>
    </section>
  );
}
