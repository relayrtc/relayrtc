"use client";

import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";
import { AnimatedValue } from "@/ui/sliding-number";

import { useState } from "react";
import type { ProjectEnvironment } from "@/lib/workspace-types";
import { useNotifications } from "@/components/notification-provider";
import { errorMessage } from "@/lib/account-api";
import { Field, FormFeedback } from "./auth-fields";
import { Button } from "./button";
import { Icon } from "./icon";

export function DeveloperEnvironment({ environments, value, onChange, disabled = false }: { environments: ProjectEnvironment[]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className="panel account-filter-form"><Field label="Environment"><Select className="input" value={value} onChange={event => onChange(event.target.value)} disabled={disabled || !environments.length} aria-label="Environment">{!environments.length && <option value="">No active environments</option>}{environments.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</Select></Field></div>;
}

export function OneTimeSecret({ value, label, onDone }: { value: string; label: string; onDone: () => void }) {
  const { notify } = useNotifications();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setError(""); notify(`${label} copied`); }
    catch (error) { setError(errorMessage(error)); }
  }
  return <div className="developer-dialog-stack"><p className="account-note">Save this {label.toLowerCase()} now. It is only shown once.</p><div className="setup-secret"><code>{value}</code><button className="icon-button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy()}><Icon name="copy" size={17.325} /></button></div><FormFeedback error={error} /><label className="account-checkbox"><Checkbox type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />I have saved this {label.toLowerCase()}.</label><Button variant="primary" disabled={!saved} onClick={onDone}>Done</Button></div>;
}

export function DeveloperChoices({ label, options, value, onChange, disabled = false }: { label: string; options: string[]; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const [search, setSearch] = useState("");
  const visible = options.filter(item => item.toLowerCase().includes(search.toLowerCase()));
  return <fieldset className="developer-choices" disabled={disabled}><legend className="field-label">{label} <span className="muted">(<AnimatedValue value={value.length} /> selected)</span></legend>{options.length > 20 && <input className="input" type="search" placeholder="Filter events" aria-label="Filter events" value={search} onChange={event => setSearch(event.target.value)} />}<div className="developer-choice-actions"><button type="button" className="auth-text-button" onClick={() => onChange([...options])}>Select all</button><button type="button" className="auth-text-button" onClick={() => onChange([])}>Clear</button></div><div className="developer-choice-list">{visible.map(item => <label className="account-checkbox" key={item}><Checkbox type="checkbox" checked={value.includes(item)} onChange={() => onChange(value.includes(item) ? value.filter(v => v !== item) : [...value, item])} /><span>{item}</span></label>)}{!visible.length && <p className="account-note">No matching events.</p>}</div></fieldset>;
}
