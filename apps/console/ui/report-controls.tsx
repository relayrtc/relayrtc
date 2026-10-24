"use client";

import type { ReactNode } from "react";
import type { IconName } from "./icon";
import { Button } from "./button";
import { SettingsRow } from "./settings-row";
import { AnimatedValue } from "./sliding-number";

export function downloadCsv(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-section report-section" aria-label={title}><h2>{title}</h2><div className="panel">{children}</div></section>;
}

export function ExportButton({ onClick }: { onClick: () => void }) {
  return <Button icon="download" className="report-export" onClick={onClick}>Export CSV</Button>;
}

export function ReportMetric({ label, value, unit = "", description, icon }: { label: string; value: string; unit?: string; description?: string; icon: IconName }) {
  return <SettingsRow className="report-metric" icon={icon} label={label} value={<span className="report-metric-number" title={description}><AnimatedValue value={value} />{unit && ` ${unit}`}</span>} trailing={<></>} />;
}
