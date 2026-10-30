"use client";

import { Select } from "@/ui/select";
import { PanelMessage } from "@/ui/panel-message";
import { AnimatedValue } from "@/ui/sliding-number";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAccount } from "./account-provider";
import { useWorkspace } from "./workspace-provider";
import { useNotifications } from "./notification-provider";
import { accountRequest, AccountApiError, errorMessage } from "@/lib/account-api";
import { accountTime, humanizeAction } from "@/lib/account-display";
import type { AuditEvent, AuditPage } from "@/lib/auth-types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { SettingsRow } from "@/ui/settings-row";

type Filters = { action: string; actorType: string; outcome: string; from: string; to: string };
const emptyFilters: Filters = { action: "", actorType: "", outcome: "", from: "", to: "" };
function filterQuery(filters: Filters, cursor?: string | null) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (!value) continue;
    query.set(name, name === "from" || name === "to" ? new Date(value).toISOString() : value.trim());
  }
  if (cursor) query.set("cursor", cursor);
  return query;
}

export function AccountActivity({ organizationId }: { organizationId?: string } = {}) {
  const { expireSession } = useAccount();
  const workspace = useWorkspace();
  const scopeRevision = organizationId ? workspace.revision : 0;
  const base = organizationId ? `/api/account/organizations/${encodeURIComponent(organizationId)}/audit` : "/api/account/audit";
  const back = organizationId ? `/organizations/${encodeURIComponent(organizationId)}` : "/account";
  const { notify } = useNotifications();
  const [page, setPage] = useState<AuditPage | null>(null);
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const sequence = useRef(0);
  const cursor = cursors[cursors.length - 1];
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current; setLoading(true); setError("");
    try {
      const result = await accountRequest<AuditPage>(`${base}?${filterQuery(filters, cursor)}`, undefined, signal);
      if (request === sequence.current) setPage(result);
    } catch (error) {
      if (signal?.aborted || request !== sequence.current) return;
      setPage(null);
      if (error instanceof AccountApiError && error.status === 401) expireSession();
      setError(errorMessage(error));
    } finally { if (!signal?.aborted && request === sequence.current) setLoading(false); }
  }, [filters, cursor, expireSession, base]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, scopeRevision]);

  function apply(event: FormEvent) {
    event.preventDefault();
    if (draft.from && draft.to && Date.parse(draft.from) >= Date.parse(draft.to)) { setError("Choose an end time after the start time."); return; }
    setPage(null); setCursors([null]); setFilters({ ...draft });
  }
  function update(name: keyof Filters, value: string) { setDraft(current => ({ ...current, [name]: value })); }
  async function exportEvents() {
    if (exporting) return;
    setExporting(true); setError("");
    try {
      const result = await accountRequest<AuditPage>(`${base}/export?${filterQuery(filters)}`);
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = organizationId ? "relayrtc-organization-audit.json" : "relayrtc-account-audit.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Security activity exported");
    } catch (error) { if (error instanceof AccountApiError && error.status === 401) expireSession(); setError(errorMessage(error)); }
    finally { setExporting(false); }
  }

  return <section className="content account-security-content" aria-label="Security activity">
    <Link href={back} className="account-back"><Icon name="chevronLeft" size={15.75} />{organizationId ? "Organization" : "Account"}</Link>
    <div className="panel"><SettingsRow icon="history" label={organizationId ? "Organization events" : "Account security events"} value={loading ? "Loading…" : page ? String(page.events.length) : "Unavailable"} trailing={<></>} /></div>
    <section className="settings-section"><h2>Filter activity</h2><form className="panel account-filter-form" onSubmit={apply}>
      <Field label="Action"><input className="input" value={draft.action} onChange={event => update("action", event.target.value)} placeholder="e.g. auth.sign-in.email" maxLength={160} /></Field>
      <div className="account-field-pair"><Field label="Actor"><Select className="input" value={draft.actorType} onChange={event => update("actorType", event.target.value)}><option value="">All actors</option><option value="USER">User</option><option value="SYSTEM">System</option><option value="API_KEY">API key</option><option value="ANONYMOUS">Anonymous</option><option value="PARTICIPANT">Room participant</option></Select></Field><Field label="Outcome"><Select className="input" value={draft.outcome} onChange={event => update("outcome", event.target.value)}><option value="">All outcomes</option><option value="SUCCESS">Success</option><option value="FAILURE">Failure</option><option value="ATTEMPT">Attempt</option></Select></Field></div>
      <div className="account-field-pair"><Field label="From"><input className="input" type="datetime-local" value={draft.from} onChange={event => update("from", event.target.value)} /></Field><Field label="To"><input className="input" type="datetime-local" value={draft.to} onChange={event => update("to", event.target.value)} /></Field></div>
      <div className="account-button-pair"><Button type="button" disabled={loading} onClick={() => { setDraft(emptyFilters); setFilters({ ...emptyFilters }); setCursors([null]); setPage(null); }}>Reset</Button><Button type="submit" variant="primary" disabled={loading}>Apply filters</Button></div>
    </form></section>
    <FormFeedback error={error} />
    <section className="settings-section"><div className="account-section-heading"><h2>Recent activity</h2><button className="auth-text-button" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
      <div className="panel" aria-busy={loading}>{page?.events.map(event => <button className="account-list-row" key={event.id} onClick={() => setSelected(event)}><span className="account-list-icon"><Icon name="history" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{humanizeAction(event.action)}</span><span className="account-list-description">{accountTime(event.occurredAt)} · {event.actorName}</span></span><span className={`account-outcome ${event.outcome === "FAILURE" ? "account-outcome-failure" : ""}`}>{humanizeAction(event.outcome.toLowerCase())}</span></button>)}{!page?.events.length && <PanelMessage className="account-panel-message" role="status">{loading ? "Loading security activity…" : error ? "Security activity couldn’t be loaded." : "No events match these filters."}</PanelMessage>}</div>
      <div className="account-pagination"><button className="icon-button" aria-label="Previous page" disabled={loading || cursors.length === 1} onClick={() => { setPage(null); setCursors(current => current.slice(0, -1)); }}><Icon name="chevronLeft" size={17.325} /></button><span>Page <AnimatedValue value={cursors.length} /></span><button className="icon-button" aria-label="Next page" disabled={loading || !page?.nextCursor} onClick={() => { if (page?.nextCursor) { setCursors(current => [...current, page.nextCursor]); setPage(null); } }}><Icon name="chevronRight" size={17.325} /></button></div>
      {page && <p className="account-section-note">Security history is retained for {page.retentionDays} days.</p>}
    </section>
    <Button className="account-section-action" icon="download" disabled={loading || exporting || !page?.events.length} onClick={() => void exportEvents()}>{exporting ? "Exporting…" : "Export latest 100 matching events"}</Button>
    <Dialog open={selected !== null} title="Security event" onClose={() => setSelected(null)}>{selected && <div className="form-stack"><dl className="account-detail-list"><div><dt>Action</dt><dd>{selected.action}</dd></div><div><dt>Occurred</dt><dd>{accountTime(selected.occurredAt)}</dd></div><div><dt>Actor</dt><dd>{selected.actorName} ({selected.actorType})</dd></div><div><dt>Outcome</dt><dd>{humanizeAction(selected.outcome.toLowerCase())}</dd></div><div><dt>Resource</dt><dd>{selected.resourceType}{selected.resourceId ? ` · ${selected.resourceId}` : ""}</dd></div><div><dt>Event ID</dt><dd><code>{selected.id}</code></dd></div><div><dt>Request ID</dt><dd><code>{selected.correlationId ?? "Unavailable"}</code></dd></div></dl>{Object.keys(selected.metadata ?? {}).length > 0 && <pre className="account-event-metadata">{JSON.stringify(selected.metadata, null, 2)}</pre>}</div>}</Dialog>
  </section>;
}
