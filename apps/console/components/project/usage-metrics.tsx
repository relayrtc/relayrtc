"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useId, useState } from "react";
import type { ProjectUsageResponse } from "@relayrtc/validation";
import { Panel } from "@/components/page/panel";
import { StatCard } from "@/components/page/stat-card";
import { formatBytes, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const tabs = ["Audio", "Video", "Screen share", "Signaling"] as const;

export function UsageMetrics({
  summary,
  dataQuality,
  period,
}: Pick<ProjectUsageResponse, "summary" | "dataQuality"> & { period: string }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Audio");
  const id = useId();
  const rows: Record<(typeof tabs)[number], [[string, string], ...[string, string][]]> = {
    Audio: [["Participant minutes", formatNumber(summary.audioParticipantSeconds / 60)]],
    Video: [["Participant minutes", formatNumber(summary.videoParticipantSeconds / 60)]],
    "Screen share": [
      ["Minutes", formatNumber(summary.screenShareSeconds / 60)],
      ["Ingress", formatBytes(summary.screenShareIngressBytes, 2)],
      ["Egress", formatBytes(summary.screenShareEgressBytes, 2)],
    ],
    Signaling: [
      ["Connections", formatNumber(summary.signalingConnections)],
      ["Connection minutes", formatNumber(summary.signalingConnectionSeconds / 60)],
      ["Messages in", formatNumber(summary.messagesIn)],
      ["Messages out", formatNumber(summary.messagesOut)],
    ],
  };
  const network = [
    ["SFU ingress", summary.sfuIngressBytes],
    ["SFU egress", summary.sfuEgressBytes],
    ["TURN ingress", summary.turnIngressBytes],
    ["TURN egress", summary.turnEgressBytes],
  ] as const;
  return (
    <>
      <section aria-labelledby={`${id}-network`} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 id={`${id}-network`} className="text-xl font-normal tracking-tight">
            Network traffic
          </h2>
          <p className="text-sm text-muted-foreground">SFU and TURN traffic over {period}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {network.map(([label, bytes]) => (
            <StatCard key={label} label={label} value={formatBytes(bytes, 2)} hint={period} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          TURN figures are estimates. Relayed traffic can appear in both SFU and TURN totals.
        </p>
      </section>
      <section aria-labelledby={`${id}-breakdown`} className="flex flex-col gap-4">
        <h2 id={`${id}-breakdown`} className="text-xl font-normal tracking-tight">
          Breakdown
        </h2>
        <div className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {tabs.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={tab === item}
              aria-controls={`${id}-panel`}
              onClick={() => setTab(item)}
              className={cn(
                "inline-flex h-9 shrink-0 items-center rounded-full px-4 text-sm transition-colors",
                tab === item
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item}
            </button>
          ))}
        </div>
        <Panel id={`${id}-panel`} className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{tab}</span>
              <span>{period}</span>
            </div>
            <p className="mt-1 text-2xl tracking-tight tabular-nums sm:text-[1.75rem]">
              {rows[tab][0][1]}
            </p>
            <p className="text-sm text-muted-foreground">{rows[tab][0][0]}</p>
          </div>
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="border-b text-muted-foreground">
                <TableHead scope="col" className="pb-2 text-left font-normal">
                  Metric
                </TableHead>
                <TableHead scope="col" className="pb-2 text-right font-normal">
                  Usage
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows[tab].map(([label, value]) => (
                <TableRow key={label} className="border-b last:border-0">
                  <TableCell className="py-2.5">{label}</TableCell>
                  <TableCell className="py-2.5 text-right tabular-nums">{value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      </section>
      {(dataQuality.sessionHistory === "partial" || dataQuality.messageHistory === "partial") && (
        <p className="text-xs text-muted-foreground">
          Some historical activity is unavailable. These totals may be incomplete.
        </p>
      )}
    </>
  );
}
