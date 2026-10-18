"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Panel } from "@/components/page/panel";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { downloadCsv } from "@/lib/csv";
import { formatNumber } from "@/lib/format";
import { environments } from "@/lib/mock-data";
import {
  type BreakdownKey,
  type Granularity,
  type GroupBy,
  formatCurrency,
  formatGb,
  getUsage,
  mediaTypes,
  networkMetrics,
  networkServices,
} from "@/lib/usage-data";
import { cn } from "@/lib/utils";

const breakdownTabs: { key: BreakdownKey; label: string }[] = [
  ...mediaTypes.map((media) => ({ key: media.key as BreakdownKey, label: media.label })),
  ...networkServices.map((service) => ({ key: service.key as BreakdownKey, label: service.label })),
];

const groupByOptions = [
  { value: "media", label: "Media type" },
  { value: "environment", label: "Environment" },
];

const environmentOptions = [
  { value: "all", label: "All" },
  ...environments.map((env) => ({ value: env.slug, label: env.name })),
];

const granularityOptions = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
];

function FilterField({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-sm text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

export function UsageDashboard({ projectId }: { projectId: string }) {
  const ids = { groupBy: useId(), environment: useId(), granularity: useId() };
  const [groupBy, setGroupBy] = useState<GroupBy>("media");
  const [environment, setEnvironment] = useState("all");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<BreakdownKey>("audio");

  const usage = useMemo(
    () => getUsage({ offset, granularity, groupBy, environment }),
    [offset, granularity, groupBy, environment],
  );

  const chartConfig = useMemo(
    () =>
      Object.fromEntries(
        usage.series.map((entry, index) => [
          entry.key,
          { label: entry.label, color: `var(--chart-${(index % 6) + 1})` },
        ]),
      ) as ChartConfig,
    [usage.series],
  );

  const countConfig = {
    value: { label: "Total", color: "var(--chart-1)" },
  } satisfies ChartConfig;

  const periodLabel = granularity === "day" ? "7d" : "28d";
  const activeBreakdown = usage.breakdown[tab];

  function handleExport() {
    downloadCsv(
      `usage-${projectId}.csv`,
      ["date", "service", "metric", "environment", "quantity", "unit", "spend_usd"],
      usage.rows.map((row) => [
        row.date,
        row.service,
        row.metric,
        row.environment,
        row.quantity,
        row.unit,
        row.spend.toFixed(4),
      ]),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:flex xl:flex-wrap xl:gap-x-5">
          <FilterField label="Group by" id={ids.groupBy}>
            <SimpleSelect
              id={ids.groupBy}
              value={groupBy}
              onValueChange={(value) => setGroupBy(value as GroupBy)}
              options={groupByOptions}
              size="sm"
              className="flex-1 sm:w-full xl:w-fit"
            />
          </FilterField>
          <FilterField label="Environment" id={ids.environment}>
            <SimpleSelect
              id={ids.environment}
              value={environment}
              onValueChange={setEnvironment}
              options={environmentOptions}
              size="sm"
              className="flex-1 sm:w-full xl:w-fit"
            />
          </FilterField>
          <FilterField label="Granularity" id={ids.granularity}>
            <SimpleSelect
              id={ids.granularity}
              value={granularity}
              onValueChange={(value) => {
                setGranularity(value as Granularity);
                setOffset(0);
              }}
              options={granularityOptions}
              size="sm"
              className="flex-1 sm:w-full xl:w-fit"
            />
          </FilterField>
        </div>

        <div className="flex items-center justify-between gap-1 sm:justify-end">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous period"
            onClick={() => setOffset((value) => value + 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-0 px-2 text-center text-sm tabular-nums" aria-live="polite">
            {usage.rangeLabel}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next period"
            disabled={offset === 0}
            onClick={() => setOffset((value) => Math.max(value - 1, 0))}
          >
            <ChevronRight />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Download CSV" onClick={handleExport}>
            <Download />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel className="flex flex-col">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Spend</span>
            <span>{periodLabel}</span>
          </div>
          <p className="text-2xl tracking-tight tabular-nums sm:text-[1.75rem]">
            {formatCurrency(usage.totals.spend)}
          </p>
          <ChartContainer config={chartConfig} className="mt-4 h-64 w-full sm:h-72">
            <BarChart data={usage.points} margin={{ left: 0, right: 0, top: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={16}
              />
              <YAxis
                width={44}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `$${value}`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {chartConfig[String(name)]?.label}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatCurrency(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {usage.series.map((entry, index) => (
                <Bar
                  key={entry.key}
                  dataKey={entry.key}
                  stackId="spend"
                  fill={`var(--color-${entry.key})`}
                  radius={index === usage.series.length - 1 ? [4, 4, 0, 0] : 0}
                />
              ))}
            </BarChart>
          </ChartContainer>
        </Panel>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <CountPanel
            title="Participant minutes"
            period={periodLabel}
            total={usage.totals.minutes}
            data={usage.minutesByBucket}
            config={countConfig}
          />
          <CountPanel
            title="Sessions"
            period={periodLabel}
            total={usage.totals.sessions}
            data={usage.sessionsByBucket}
            config={countConfig}
          />
        </div>
      </div>

      <section aria-labelledby="network-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 id="network-heading" className="text-xl font-normal tracking-tight">
            Network traffic
          </h2>
          <p className="text-sm text-muted-foreground">
            {formatGb(usage.totals.networkGb)} transferred over {periodLabel}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {networkMetrics.map((metric) => (
            <CountPanel
              key={metric.key}
              title={metric.label}
              period={periodLabel}
              total={formatGb(usage.network[metric.key].gb)}
              subtitle={`${formatCurrency(usage.network[metric.key].spend)} at ${formatCurrency(metric.rate)}/GB`}
              data={usage.network[metric.key].byBucket}
              config={{
                value: {
                  label: metric.label,
                  color: metric.service === "sfu" ? "var(--chart-2)" : "var(--chart-6)",
                },
              }}
              valueFormatter={formatGb}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="breakdown-heading" className="flex flex-col gap-4">
        <h2 id="breakdown-heading" className="text-xl font-normal tracking-tight">
          Breakdown
        </h2>
        <div
          role="tablist"
          aria-label="Product"
          className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0"
        >
          {breakdownTabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              aria-controls="breakdown-panel"
              onClick={() => setTab(item.key)}
              className={cn(
                "inline-flex h-9 shrink-0 items-center rounded-full px-4 text-sm transition-colors",
                tab === item.key
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <Panel id="breakdown-panel" role="tabpanel" className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{breakdownTabs.find((item) => item.key === tab)?.label}</span>
              <span>{periodLabel}</span>
            </div>
            <p className="text-2xl tracking-tight tabular-nums sm:text-[1.75rem]">
              {formatCurrency(activeBreakdown.spend)}
            </p>
          </div>
          <div className="overflow-x-auto">
            <Table className="w-full text-sm">
              <TableHeader>
                <TableRow className="border-b text-muted-foreground">
                  <TableHead scope="col" className="pb-2 text-left font-normal">
                    Type
                  </TableHead>
                  <TableHead scope="col" className="pb-2 text-right font-normal">
                    {activeBreakdown.unit === "GB" ? "Data" : "Minutes"}
                  </TableHead>
                  <TableHead scope="col" className="pb-2 text-right font-normal">
                    Spend
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeBreakdown.rows.map((row) => (
                  <TableRow key={row.label} className="border-b">
                    <TableCell className="py-2.5">{row.label}</TableCell>
                    <TableCell className="py-2.5 text-right tabular-nums">
                      {formatQuantity(row.quantity, activeBreakdown.unit)}
                    </TableCell>
                    <TableCell className="py-2.5 text-right tabular-nums">
                      {formatCurrency(row.spend)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="font-medium">
                  <TableHead scope="row" className="pt-2.5 text-left font-medium">
                    Total
                  </TableHead>
                  <TableCell className="pt-2.5 text-right tabular-nums">
                    {formatQuantity(activeBreakdown.quantity, activeBreakdown.unit)}
                  </TableCell>
                  <TableCell className="pt-2.5 text-right tabular-nums">
                    {formatCurrency(activeBreakdown.spend)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </Panel>
      </section>
    </div>
  );
}

function formatQuantity(value: number, unit: "minutes" | "GB") {
  return unit === "GB" ? formatGb(value) : formatNumber(value);
}

function CountPanel({
  title,
  period,
  total,
  subtitle,
  data,
  config,
  valueFormatter,
}: {
  title: string;
  period: string;
  total: number | string;
  subtitle?: string;
  data: { label: string; value: number }[];
  config: ChartConfig;
  valueFormatter?: (value: number) => string;
}) {
  const tooltipContent = valueFormatter ? (
    <ChartTooltipContent
      hideLabel={false}
      formatter={(value) => (
        <span className="font-mono tabular-nums">{valueFormatter(Number(value))}</span>
      )}
    />
  ) : (
    <ChartTooltipContent hideLabel={false} />
  );

  return (
    <Panel className="flex flex-col">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{title}</span>
        <span>{period}</span>
      </div>
      <p className="text-2xl tracking-tight tabular-nums sm:text-[1.75rem]">
        {typeof total === "number" ? formatNumber(total) : total}
      </p>
      {subtitle ? <p className="text-xs text-muted-foreground tabular-nums">{subtitle}</p> : null}
      <ChartContainer config={config} className="mt-3 h-24 w-full">
        <BarChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
          <XAxis dataKey="label" hide />
          <ChartTooltip content={tooltipContent} />
          <Bar dataKey="value" fill="var(--color-value)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </Panel>
  );
}
