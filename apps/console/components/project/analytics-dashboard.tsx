"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useId, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Panel, PanelTitle } from "@/components/page/panel";
import { SimpleSelect } from "@/components/page/simple-select";
import { StatCard } from "@/components/page/stat-card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { AnalyticsRange, ProjectAnalyticsData } from "@/lib/reporting/analytics-view";
import type { ConsoleEnvironment } from "@/lib/console-types";
import { formatBytes, formatDuration, formatMinutes, formatNumber } from "@/lib/format";
import { ReportingRefresh } from "./reporting-refresh";
import { cn } from "@/lib/utils";

const ranges: {
  value: AnalyticsRange;
  label: string;
}[] = [
  {
    value: "live",
    label: "Live",
  },
  {
    value: "24h",
    label: "Last 24 hours",
  },
  {
    value: "7d",
    label: "Last 7 days",
  },
  {
    value: "30d",
    label: "Last 30 days",
  },
];

const trafficConfig = {
  participants: {
    label: "Peak concurrent participants",
    color: "var(--chart-1)",
  },
  sessions: {
    label: "Sessions",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const sfuConfig = {
  sfuEgress: {
    label: "SFU egress",
    color: "var(--chart-1)",
  },
  sfuIngress: {
    label: "SFU ingress",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const turnConfig = {
  turnEgress: {
    label: "TURN egress",
    color: "var(--chart-6)",
  },
  turnIngress: {
    label: "TURN ingress",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig;

const rttConfig = {
  rtt: {
    label: "Round-trip time (ms)",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const lossConfig = {
  packetLoss: {
    label: "Packet loss (%)",
    color: "var(--chart-4)",
  },
  jitter: {
    label: "Jitter (ms)",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig;

const regionConfig = {
  sessions: {
    label: "Sessions",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

function AnalyticsEmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-52 place-items-center text-sm text-muted-foreground">{children}</div>
  );
}

export function AnalyticsDashboard({
  range,
  environment,
  environments,
  data,
}: {
  range: AnalyticsRange;
  environment: string;
  environments: readonly ConsoleEnvironment[];
  data: ProjectAnalyticsData;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const environmentId = useId();

  const environmentOptions = [
    {
      value: "all",
      label: "All environments",
    },
    ...environments.map((item) => ({
      value: item.id,
      label: item.name,
    })),
  ];

  const bucketLabel = range === "live" ? "minute" : range === "24h" ? "hour" : "day";

  const totalNetwork =
    data.network.sfuIngress +
    data.network.sfuEgress +
    data.network.turnIngress +
    data.network.turnEgress;

  const totalQualitySamples = data.qualityDistribution.reduce(
    (total, item) => total + item.count,
    0,
  );

  function updateFilters(next: { range?: AnalyticsRange; environment?: string }) {
    const params = new URLSearchParams(searchParams.toString());

    if (next.range) {
      params.set("range", next.range);
    }

    if (next.environment) {
      params.set("environment", next.environment);
    }

    startTransition(() =>
      router.replace(`${pathname}?${params.toString()}`, {
        scroll: false,
      }),
    );
  }

  return (
    <div className="flex flex-col gap-6" aria-busy={pending}>
      <ReportingRefresh startedAt={data.window.startedAt} endedAt={data.window.endedAt} intervalMs={range === "live" ? 1000 : 5000} />
      {pending && (
        <span role="status" className="text-sm text-muted-foreground">
          Refreshing analytics...
        </span>
      )}
      {(data.dataQuality.sessionHistory === "partial" ||
        data.dataQuality.messageHistory === "partial") && (
        <p role="status" className="text-sm text-muted-foreground">
          Some historical activity is unavailable. These totals may be incomplete.
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="radiogroup"
          aria-label="Time range"
          className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0"
        >
          {ranges.map((item) => {
            const selected = range === item.value;

            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() =>
                  updateFilters({
                    range: item.value,
                  })
                }
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors",
                  selected
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.value === "live" ? (
                  <span
                    className={cn("size-2 rounded-full bg-current", selected && "animate-pulse")}
                  />
                ) : null}

                <span className={cn(item.value === "live" && selected && "animate-pulse")}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor={environmentId} className="sr-only">
            Environment
          </label>

          <SimpleSelect
            id={environmentId}
            value={environment}
            onValueChange={(value) =>
              updateFilters({
                environment: value,
              })
            }
            options={environmentOptions}
            size="sm"
            className="w-full sm:w-48"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Peak concurrent" value={formatNumber(data.summary.peakConcurrent)} />

        <StatCard label="Total sessions" value={formatNumber(data.summary.totalSessions)} />

        <StatCard
          label="Avg. session length"
          value={formatDuration(data.summary.averageSessionSeconds)}
        />

        <StatCard
          label="Participant minutes"
          value={<span title={formatDuration(data.summary.participantSeconds)}>{formatMinutes(data.summary.participantSeconds)}</span>}
        />

        <StatCard
          label="Connection success"
          value={
            data.summary.totalSessions === 0
              ? "No sessions"
              : `${data.summary.connectionSuccessRate.toFixed(1)}%`
          }
        />
      </div>

      <Panel>
        <PanelTitle
          title="Traffic"
          description="Peak concurrent participants and sessions overlapping each bucket (UTC)"
        />

        {data.summary.totalSessions > 0 ? (
          <ChartContainer config={trafficConfig} className="mt-4 h-64 w-full sm:h-72">
            <AreaChart
              data={data.traffic}
              margin={{
                left: 0,
                right: 0,
                top: 4,
              }}
            >
              <defs>
                <linearGradient id="fill-participants" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-participants)" stopOpacity={0.4} />

                  <stop offset="95%" stopColor="var(--color-participants)" stopOpacity={0.02} />
                </linearGradient>
              </defs>

              <CartesianGrid vertical={false} />

              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={range === "live" ? 8 : 24}
              />

              <YAxis width={40} tickLine={false} axisLine={false} />

              <ChartTooltip content={<ChartTooltipContent indicator="line" />} />

              <ChartLegend content={<ChartLegendContent />} />

              <Area
                dataKey="participants"
                type="monotone"
                stroke="var(--color-participants)"
                strokeWidth={2}
                fill="url(#fill-participants)"
              />

              <Area
                dataKey="sessions"
                type="monotone"
                stroke="var(--color-sessions)"
                strokeWidth={2}
                fill="var(--color-sessions)"
                fillOpacity={0.08}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <AnalyticsEmptyState>No traffic data for this period.</AnalyticsEmptyState>
        )}
      </Panel>

      <section aria-labelledby="network-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 id="network-heading" className="text-xl font-normal tracking-tight">
            Network traffic
          </h2>

          <p className="text-sm text-muted-foreground">
            {formatBytes(totalNetwork, 2)} observed across service interfaces
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="SFU ingress" value={formatBytes(data.network.sfuIngress, 2)} />

          <StatCard label="SFU egress" value={formatBytes(data.network.sfuEgress, 2)} />

          <StatCard
            label="TURN ingress"
            value={
              data.dataQuality.turnTraffic === "unavailable"
                ? "Unavailable"
                : formatBytes(data.network.turnIngress, 2)
            }
            hint={
              data.dataQuality.turnTraffic === "partial"
                ? "Partial measurement"
                : data.dataQuality.turnTraffic === "unavailable"
                  ? "Measurement unavailable"
                  : "Observed"
            }
          />

          <StatCard
            label="TURN egress"
            value={
              data.dataQuality.turnTraffic === "unavailable"
                ? "Unavailable"
                : formatBytes(data.network.turnEgress, 2)
            }
            hint={
              data.dataQuality.turnTraffic === "partial"
                ? "Partial measurement"
                : data.dataQuality.turnTraffic === "unavailable"
                  ? "Measurement unavailable"
                  : "Observed"
            }
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelTitle
              title="SFU traffic"
              description={`Data received and sent by the SFU per ${bucketLabel}`}
            />

            <ChartContainer config={sfuConfig} className="mt-4 h-56 w-full">
              <AreaChart
                data={data.networkSeries}
                margin={{
                  left: 0,
                  right: 0,
                  top: 4,
                }}
              >
                <CartesianGrid vertical={false} />

                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={range === "live" ? 8 : 24}
                />

                <YAxis
                  width={44}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}G`}
                />

                <ChartTooltip content={<ChartTooltipContent indicator="line" />} />

                <ChartLegend content={<ChartLegendContent />} />

                <Area
                  dataKey="sfuEgress"
                  type="monotone"
                  stroke="var(--color-sfuEgress)"
                  fill="var(--color-sfuEgress)"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />

                <Area
                  dataKey="sfuIngress"
                  type="monotone"
                  stroke="var(--color-sfuIngress)"
                  fill="var(--color-sfuIngress)"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </Panel>

          <Panel>
            <PanelTitle title="TURN traffic" description={`Relayed data per ${bucketLabel}`} />

            {data.dataQuality.turnTraffic === "unavailable" ? (
              <AnalyticsEmptyState>
                TURN usage could not be measured for this period.
              </AnalyticsEmptyState>
            ) : (
              <>
                {data.dataQuality.turnTraffic === "partial" && (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Only observed TURN activity is shown.
                  </p>
                )}
                <ChartContainer config={turnConfig} className="mt-4 h-56 w-full">
                  <AreaChart
                    data={data.networkSeries}
                    margin={{
                      left: 0,
                      right: 0,
                      top: 4,
                    }}
                  >
                    <CartesianGrid vertical={false} />

                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={range === "live" ? 8 : 24}
                    />

                    <YAxis
                      width={44}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value) => `${value}G`}
                    />

                    <ChartTooltip content={<ChartTooltipContent indicator="line" />} />

                    <ChartLegend content={<ChartLegendContent />} />

                    <Area
                      dataKey="turnEgress"
                      type="monotone"
                      stroke="var(--color-turnEgress)"
                      fill="var(--color-turnEgress)"
                      fillOpacity={0.15}
                      strokeWidth={2}
                    />

                    <Area
                      dataKey="turnIngress"
                      type="monotone"
                      stroke="var(--color-turnIngress)"
                      fill="var(--color-turnIngress)"
                      fillOpacity={0.15}
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ChartContainer>
              </>
            )}
          </Panel>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelTitle
            title="Round-trip time"
            description="Average latency between client and SFU"
          />

          {data.quality.some((point) => point.sampleCount > 0) ? (
            <ChartContainer config={rttConfig} className="mt-4 h-52 w-full">
              <LineChart
                data={data.quality}
                margin={{
                  left: 0,
                  right: 0,
                  top: 4,
                }}
              >
                <CartesianGrid vertical={false} />

                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={range === "live" ? 8 : 24}
                />

                <YAxis width={40} tickLine={false} axisLine={false} />

                <ChartTooltip content={<ChartTooltipContent />} />

                <Line
                  dataKey="rtt"
                  type="monotone"
                  stroke="var(--color-rtt)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
          ) : (
            <AnalyticsEmptyState>No connection quality samples in this period.</AnalyticsEmptyState>
          )}
        </Panel>

        <Panel>
          <PanelTitle
            title="Packet loss and jitter"
            description="Network health across RTC sessions"
          />

          {data.quality.some((point) => point.sampleCount > 0) ? (
            <ChartContainer config={lossConfig} className="mt-4 h-52 w-full">
              <LineChart
                data={data.quality}
                margin={{
                  left: 0,
                  right: 0,
                  top: 4,
                }}
              >
                <CartesianGrid vertical={false} />

                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={range === "live" ? 8 : 24}
                />

                <YAxis width={40} tickLine={false} axisLine={false} />

                <ChartTooltip content={<ChartTooltipContent />} />

                <Line
                  dataKey="packetLoss"
                  type="monotone"
                  stroke="var(--color-packetLoss)"
                  strokeWidth={2}
                  dot={false}
                />

                <Line
                  dataKey="jitter"
                  type="monotone"
                  stroke="var(--color-jitter)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
          ) : (
            <AnalyticsEmptyState>No connection quality samples in this period.</AnalyticsEmptyState>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelTitle
            title="Sessions by region"
            description="Where RelayRTC traffic is being handled"
          />

          {data.regions.length > 0 ? (
            <ChartContainer config={regionConfig} className="mt-4 h-64 w-full">
              <BarChart
                data={data.regions}
                layout="vertical"
                margin={{
                  left: 0,
                  right: 8,
                }}
              >
                <CartesianGrid horizontal={false} />

                <YAxis
                  dataKey="name"
                  type="category"
                  tickLine={false}
                  axisLine={false}
                  width={120}
                  tick={{
                    fontSize: 12,
                  }}
                />

                <XAxis type="number" hide />

                <ChartTooltip content={<ChartTooltipContent />} cursor={false} />

                <Bar dataKey="sessions" fill="var(--color-sessions)" radius={4} />
              </BarChart>
            </ChartContainer>
          ) : (
            <AnalyticsEmptyState>No regional session data yet.</AnalyticsEmptyState>
          )}

          <a
            href="https://ipinfo.io/lite"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Country data powered by IPinfo
          </a>
        </Panel>

        <Panel>
          <PanelTitle
            title="Connection quality"
            description="RTC quality classifications in the selected range"
          />

          {totalQualitySamples > 0 ? (
            <ul className="mt-5 grid gap-4">
              {data.qualityDistribution.map((item) => {
                const share =
                  totalQualitySamples > 0 ? (item.count / totalQualitySamples) * 100 : 0;

                return (
                  <li key={item.quality} className="grid gap-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize">{item.quality}</span>

                      <span className="tabular-nums text-muted-foreground">
                        {share.toFixed(1)}%
                      </span>
                    </div>

                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-chart-1"
                        style={{
                          width: `${share}%`,
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <AnalyticsEmptyState>No RTC quality samples yet.</AnalyticsEmptyState>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelTitle title="Top rooms" description="Busiest rooms in the selected range" />

        <div className="mt-3 overflow-x-auto">
          <Table className="w-full min-w-96 text-sm">
            <TableHeader>
              <TableRow className="border-b text-muted-foreground">
                <TableHead scope="col" className="pb-2 text-left font-normal">
                  Room
                </TableHead>

                <TableHead scope="col" className="pb-2 text-right font-normal">
                  Participants
                </TableHead>

                <TableHead scope="col" className="pb-2 text-right font-normal">
                  Minutes
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {data.topRooms.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    No room activity in this period.
                  </TableCell>
                </TableRow>
              ) : (
                data.topRooms.map((room) => (
                  <TableRow key={room.id} className="border-b last:border-0">
                    <TableCell className="py-3 font-mono text-[0.8125rem]">{room.name}</TableCell>

                    <TableCell className="py-3 text-right tabular-nums">
                      {formatNumber(room.participants)}
                    </TableCell>

                    <TableCell className="py-3 text-right tabular-nums">
                      <span title={formatDuration(room.minutes * 60)}>{formatMinutes(room.minutes * 60)}</span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
