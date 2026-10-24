"use client";

import { Select } from "@/ui/select";
import { useRooms } from "./rooms-provider";
import { Field } from "@/ui/auth-fields";

export function ReportingEnvironment({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const rooms = useRooms();
  return <div className="panel account-filter-form"><Field label="Environment"><Select className="input" value={value} onChange={event => onChange(event.target.value)} disabled={disabled || !rooms.ready}><option value="all">All environments</option>{rooms.environments.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</Select></Field></div>;
}
export function ReportingRange<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return <div className="segmented-control report-range reporting-range" role="group" aria-label="Reporting time range">{options.map(item => <button key={item.value} type="button" aria-pressed={value === item.value} className={value === item.value ? "segment-active" : ""} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}
