"use client";

import { AnimatedValue } from "@/ui/sliding-number";

import { useEffect, useId, useRef, useState } from "react";
import { formatMetric } from "@/lib/rtc-reports";
export type ChartSeries = { label: string; color: "orange" | "gray"; values: (number | null)[] };
type ChartProps = { title: string; labels: string[]; fullLabels: string[]; series: ChartSeries[]; unit: string };
const measured = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export function LineChart({ title, labels, fullLabels, series, unit }: ChartProps) {
  const id = useId(), plot = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null), [width, setWidth] = useState(320);
  const hasValues = series.some(item => item.values.some(measured));
  useEffect(() => {
    if (!plot.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width)));
    observer.observe(plot.current); return () => observer.disconnect();
  }, [labels.length, hasValues]);
  if (!labels.length || !series.length || !hasValues) return <p className="account-note" role="status">No measurements are available for this period.</p>;
  const height = 220, top = 14, bottom = 26, left = 42, right = 10;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maxValue = series.reduce((maximum, item) => item.values.reduce<number>((value, point) => measured(point) ? Math.max(value, point) : value, maximum), 0.01);
  const ceiling = Math.ceil(maxValue * 1.15 * 10) / 10;
  const x = (index: number) => left + index / Math.max(1, labels.length - 1) * plotWidth;
  const y = (value: number) => top + plotHeight * (1 - value / ceiling);
  const color = (value: "orange" | "gray") => value === "orange" ? "var(--primary)" : "#b8bec7";
  const indices = [...new Set([0, Math.floor((labels.length - 1) / 3), Math.floor((labels.length - 1) * 2 / 3), labels.length - 1])];
  const selected = Math.max(0, Math.min(active ?? labels.length - 1, labels.length - 1));
  const valueAt = (item: ChartSeries, index: number) => measured(item.values[index]) ? `${formatMetric(item.values[index])}${unit ? ` ${unit}` : ""}` : "No measurement";
  const summary = `${fullLabels[selected]}. ${series.map(item => `${item.label}: ${valueAt(item, selected)}`).join(". ")}`;
  return <div className="rtc-chart"><div className="chart-legend">{series.map(item => <span key={item.label}><i style={{ background: color(item.color) }} />{item.label}</span>)}<span className="chart-unit">{unit}</span></div>
    <div ref={plot} className="chart-plot" tabIndex={0} role="slider" aria-label={`Inspect ${title}`} aria-valuemin={1} aria-valuemax={labels.length} aria-valuenow={selected + 1} aria-valuetext={summary}
      onFocus={() => setActive(labels.length - 1)} onBlur={() => setActive(null)} onPointerLeave={() => setActive(null)}
      onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); const position = (event.clientX - rect.left) / rect.width * width; setActive(Math.max(0, Math.min(labels.length - 1, Math.round((position - left) / plotWidth * (labels.length - 1))))); }}
      onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); setActive(event.key === "Home" ? 0 : event.key === "End" ? labels.length - 1 : Math.max(0, Math.min(labels.length - 1, selected + (event.key === "ArrowLeft" ? -1 : 1)))); } }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}, ${labels[0]} to ${labels[labels.length - 1]}`}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity=".13" /><stop offset="100%" stopColor="var(--primary)" stopOpacity="0" /></linearGradient></defs>
        {[0, 1, 2, 3].map(tick => { const value = ceiling * tick / 3; return <g key={tick}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--border)" strokeDasharray="3 5" /><text x={left - 8} y={y(value) + 3} textAnchor="end">{formatMetric(value)}</text></g>; })}
        {series.map(item => {
          const segments: { index: number; value: number }[][] = []; let segment: { index: number; value: number }[] = [];
          item.values.forEach((value, index) => { if (measured(value)) segment.push({ index, value }); else if (segment.length) { segments.push(segment); segment = []; } });
          if (segment.length) segments.push(segment);
          return <g key={item.label}>{segments.map((points, index) => <g key={index}>{item.color === "orange" && points.length > 1 && <polygon points={`${x(points[0].index)},${height - bottom} ${points.map(point => `${x(point.index)},${y(point.value)}`).join(" ")} ${x(points[points.length - 1].index)},${height - bottom}`} fill={`url(#${id})`} />}<polyline points={points.map(point => `${x(point.index)},${y(point.value)}`).join(" ")} fill="none" stroke={color(item.color)} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />{points.length === 1 && <circle cx={x(points[0].index)} cy={y(points[0].value)} r="3" fill={color(item.color)} />}</g>)}</g>;
        })}
        {indices.map(index => <text key={index} x={x(index)} y={height - 5} textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}>{labels[index]}</text>)}
        {active !== null && <g><line x1={x(selected)} x2={x(selected)} y1={top} y2={height - bottom} stroke="#d8d8dc" strokeDasharray="4 4" />{series.map(item => measured(item.values[selected]) ? <circle key={item.label} cx={x(selected)} cy={y(item.values[selected]!)} r="3.8" fill={color(item.color)} stroke="white" strokeWidth="2" /> : null)}</g>}
      </svg>
      {active !== null && <div className="chart-tooltip" style={{ left: `clamp(8px, ${x(selected) / width * 100}%, calc(100% - 218px))` }}><strong>{fullLabels[selected]}</strong>{series.map(item => <span key={item.label}><i style={{ background: color(item.color) }} />{item.label}<b><AnimatedValue value={valueAt(item, selected)} /></b></span>)}</div>}
    </div><p className="chart-hint">Hover to inspect · Use arrow keys when focused</p></div>;
}
