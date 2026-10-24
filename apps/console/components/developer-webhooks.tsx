"use client";

import { PanelMessage } from "@/ui/panel-message";
import { AnimatedValue } from "@/ui/sliding-number";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";
import { WebhookDeliveries } from "./webhook-deliveries";
import { accountRequest } from "@/lib/account-api";
import { accountTime } from "@/lib/account-display";
import { developerPath, projectHref, webhookHref, webhookPath } from "@/lib/developer-api";
import type { DeveloperProject, RevealedWebhook, SignatureContract, WebhookEndpoint, WebhookList } from "@/lib/developer-types";
import { DeveloperChoices, DeveloperEnvironment, OneTimeSecret } from "@/ui/developer-fields";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { SettingsRow } from "@/ui/settings-row";
import { Switch } from "@/ui/switch";
import { WorkspaceState } from "@/ui/workspace-state";

export function DeveloperWebhooks({ projectId, initialEnvironmentId }: { projectId: string; initialEnvironmentId?: string }) {
  const resource = useWorkspaceResource<DeveloperProject>(developerPath(projectId));
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId ?? "");
  if (!resource.data) return <WorkspaceState error={resource.error} title="Loading webhooks" onRetry={() => void resource.refresh().catch(() => {})} />;
  const environments = resource.data.environments.filter(item => item.status === "active");
  const active = environments.find(item => item.id === environmentId) ?? environments.find(item => item.type === "development") ?? environments[0];
  return <section className="content account-content" aria-label="Webhooks"><Link className="account-back" href={`${projectHref(projectId)}/developer`}><Icon name="chevronLeft" size={15.75} />Developer Controls</Link><DeveloperEnvironment environments={environments} value={active?.id ?? ""} onChange={setEnvironmentId} />{active ? <WebhookListView key={active.id} details={resource.data} environmentId={active.id} /> : <PanelMessage className="account-panel-message">No active environments.</PanelMessage>}</section>;
}

function WebhookListView({ details, environmentId }: { details: DeveloperProject; environmentId: string }) {
  const base = webhookPath(details.project.id, environmentId);
  const resource = useWorkspaceResource<WebhookList>(`${base}?limit=100&offset=0`);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { notify } = useNotifications();
  const canManage = details.canManage && details.project.status === "active";
  const visible = resource.data?.endpoints.filter(item => item.url.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <><input className="input workspace-search" type="search" placeholder="Search webhooks" aria-label="Search webhooks" value={search} onChange={event => setSearch(event.target.value)} /><section className="settings-section"><h2>Webhooks</h2><div className="panel">{visible.map(item => <Link className="account-list-row" key={item.id} href={webhookHref(details.project.id, environmentId, item.id)}><span className="account-list-icon"><Icon name="link" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{item.url}</span><span className="account-list-description"><AnimatedValue value={item.eventTypes.length} /> event{item.eventTypes.length === 1 ? "" : "s"} · Signing key v{item.signingSecretVersion}</span></span><span className={`account-outcome ${item.status === "disabled" ? "developer-badge-muted" : ""}`}>{item.status === "enabled" ? "Enabled" : "Disabled"}</span></Link>)}{!visible.length && <PanelMessage className="account-panel-message" role="status">{(resource.loading && !resource.data) ? "Loading webhooks…" : resource.error ? "Webhooks unavailable." : search ? "No matching webhooks." : "No webhooks in this environment."}</PanelMessage>}</div><FormFeedback error={resource.error} />{resource.error && <Button className="workspace-section-button" onClick={() => void resource.refresh().catch(() => {})}>Try again</Button>}<p className="account-section-note">Receive signed RTC events at your endpoint. Select a webhook to view delivery history and replay completed deliveries.</p>{canManage && <><Button className="workspace-section-button" icon="plus" disabled={!details.signingConfigured} onClick={() => setOpen(true)}>Create Webhook</Button>{!details.signingConfigured && <p className="account-section-note">Webhook signing is unavailable. Contact your instance administrator.</p>}</>}{!canManage && <p className="account-section-note">Owners and admins can manage webhook configuration.</p>}</section><Dialog open={open} title="Create Webhook" dismissible={!busy} onClose={() => setOpen(false)}>{open && <WebhookForm details={details} base={base} onBusy={setBusy} onClose={() => setOpen(false)} onChanged={message => { notify(message); void resource.refresh().catch(() => {}); }} />}</Dialog></>;
}

export function DeveloperWebhookDetails({ projectId, environmentId, endpointId }: { projectId: string; environmentId: string; endpointId: string }) {
  const details = useWorkspaceResource<DeveloperProject>(developerPath(projectId));
  const base = webhookPath(projectId, environmentId, endpointId);
  const endpoint = useWorkspaceResource<WebhookEndpoint>(base);
  const [dialog, setDialog] = useState<"edit" | "rotate" | "delete" | "signature" | null>(null);
  const [busy, setBusy] = useState(false);
  const mutation = useDeveloperMutation();
  const { notify } = useNotifications(); const router = useRouter();
  if (!details.data || !endpoint.data) return <WorkspaceState error={details.error || endpoint.error} title="Loading webhook" onRetry={() => { void details.refresh().catch(() => {}); void endpoint.refresh().catch(() => {}); }} />;
  const data = endpoint.data;
  const environment = details.data.environments.find(item => item.id === environmentId);
  const canManage = details.data.canManage && details.data.project.status === "active" && environment?.status === "active";
  const list = `${projectHref(projectId)}/webhooks?environment=${encodeURIComponent(environmentId)}`;
  const changed = (message: string) => { notify(message); void endpoint.refresh().catch(() => {}); };
  // Keep a newly revealed secret mounted until the user dismisses its dialog.
  const closeDialog = () => { setDialog(null); if (dialog === "rotate") void endpoint.refresh().catch(() => {}); };
  return <section className="content account-content" aria-label="Webhook settings"><Link className="account-back" href={list}><Icon name="chevronLeft" size={15.75} />Webhooks</Link><div className="panel"><SettingsRow icon="link" label="Endpoint URL" value={data.url} onClick={canManage && !mutation.pending ? () => setDialog("edit") : undefined} trailing={canManage ? undefined : <></>} /><SettingsRow icon="project" label="Environment" value={environment?.name ?? environmentId} trailing={<></>} /><SettingsRow icon="play" label="Enabled" trailing={<Switch checked={data.status === "enabled"} disabled={!canManage || mutation.pending || busy} label="Webhook enabled" onChange={enabled => void mutation.run(async () => { await accountRequest(`${base}/update`, { status: enabled ? "enabled" : "disabled" }); changed(enabled ? "Webhook enabled" : "Webhook disabled"); })} />} /><SettingsRow icon="signaling" label="Subscribed events" value={String(data.eventTypes.length)} onClick={() => setDialog("edit")} /></div><FormFeedback error={mutation.error} /><section className="settings-section"><h2>Signing</h2><div className="panel"><SettingsRow icon="secretKeys" label="Signing key" value={`Version ${data.signingSecretVersion}`} trailing={<></>} /><SettingsRow icon="calendar" label="Last rotated" value={accountTime(data.signingSecretRotatedAt)} trailing={<></>} /><SettingsRow icon="shield" label="Signature and retry policy" onClick={() => setDialog("signature")} />{canManage && <SettingsRow icon="history" label="Rotate signing secret" onClick={() => setDialog("rotate")} />}</div><p className="account-section-note">Verify signatures using the raw request body before processing events. Signing secrets are only revealed when created or rotated.</p></section><WebhookDeliveries key={base} base={base} canManage={canManage} endpointEnabled={data.status === "enabled"} /><section className="settings-section"><h2>Webhook</h2><div className="panel"><SettingsRow icon="calendar" label="Created" value={accountTime(data.createdAt)} trailing={<></>} />{canManage && <SettingsRow icon="trash" label="Delete webhook" className="text-danger" onClick={() => setDialog("delete")} />}</div></section><Dialog open={dialog !== null} title={dialog === "edit" ? "Webhook configuration" : dialog === "rotate" ? "Rotate signing secret" : dialog === "delete" ? "Delete webhook" : "Signature and retry policy"} dismissible={!busy} onClose={closeDialog}>{dialog === "edit" && <WebhookForm key={`edit:${data.id}`} base={base} endpoint={data} details={details.data} readOnly={!canManage} onBusy={setBusy} onClose={closeDialog} onChanged={changed} />}{(dialog === "rotate" || dialog === "delete") && <WebhookAction key={dialog} action={dialog} base={base} onBusy={setBusy} onClose={closeDialog} onChanged={message => { if (dialog === "delete") { notify(message); router.replace(list); } else if (dialog === "rotate") notify(message); else changed(message); }} />}{dialog === "signature" && <WebhookSignature base={webhookPath(projectId, environmentId)} />}</Dialog></section>;
}

function WebhookForm({ base, details, endpoint, readOnly = false, onBusy, onClose, onChanged }: {
  base: string; details: DeveloperProject; endpoint?: WebhookEndpoint; readOnly?: boolean;
  onBusy: (busy: boolean) => void; onClose: () => void; onChanged: (message: string) => void;
}) {
  const [events, setEvents] = useState(endpoint?.eventTypes ?? []);
  const [revealed, setRevealed] = useState<string>();
  const mutation = useDeveloperMutation(onBusy);
  if (revealed) return <OneTimeSecret label="Signing secret" value={revealed} onDone={onClose} />;
  return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (readOnly) return; const form = new FormData(event.currentTarget); void mutation.run(async () => { if (!events.length) throw new Error("Select at least one event."); const url = String(form.get("url")).trim(); let parsed: URL; try { parsed = new URL(url); } catch { throw new Error("Enter a valid public HTTP or HTTPS URL."); } if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("Use a public HTTP or HTTPS URL without credentials or fragments."); const result = await accountRequest<WebhookEndpoint | RevealedWebhook>(endpoint ? `${base}/update` : base, { url, eventTypes: events, status: form.get("status") }); if ("signingSecret" in result) setRevealed(result.signingSecret); else onClose(); onChanged(endpoint ? "Webhook updated" : "Webhook created"); }); }}><fieldset disabled={mutation.pending || readOnly}><FormFeedback error={mutation.error} /><Field label="Endpoint URL"><input className="input" type="url" name="url" defaultValue={endpoint?.url ?? ""} maxLength={2048} placeholder="https://example.com/webhooks/relayrtc" autoCapitalize="none" spellCheck={false} autoFocus required /></Field><Field label="Status"><Select className="input" name="status" defaultValue={endpoint?.status ?? "enabled"}><option value="enabled">Enabled</option><option value="disabled">Disabled</option></Select></Field><DeveloperChoices label="Events" options={details.eventTypes} value={events} onChange={setEvents} disabled={mutation.pending || readOnly} />{!readOnly && <Button type="submit" variant="primary" disabled={mutation.pending || !events.length}>{mutation.pending ? "Saving…" : endpoint ? "Save changes" : "Create Webhook"}</Button>}</fieldset>{readOnly && <p className="account-note">Only owners and admins can change this configuration.</p>}</form>;
}

function WebhookAction({ action, base, onBusy, onClose, onChanged }: { action: "rotate" | "delete"; base: string; onBusy: (busy: boolean) => void; onClose: () => void; onChanged: (message: string) => void }) {
  const mutation = useDeveloperMutation(onBusy);
  const [revealed, setRevealed] = useState<string>();
  if (revealed) return <OneTimeSecret value={revealed} label="Signing secret" onDone={onClose} />;
  return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutation.run(async () => { if (action === "rotate") { const result = await accountRequest<RevealedWebhook>(`${base}/rotate-secret`, {}); setRevealed(result.signingSecret); onChanged("Signing secret rotated"); } else { await accountRequest(`${base}/delete`, {}); onClose(); onChanged("Webhook deleted"); } }); }}><fieldset disabled={mutation.pending}><FormFeedback error={mutation.error} /><p className="account-note">{action === "rotate" ? "Rotation replaces the signing secret immediately. Update your receiver with the replacement secret before processing subsequent deliveries." : "Delete this webhook? It will stop receiving events. This cannot be undone."}</p><label className="account-checkbox"><Checkbox type="checkbox" required />{action === "rotate" ? "I understand the previous signing secret will stop working." : "I want to delete this webhook."}</label><Button type="submit" variant={action === "delete" ? "danger" : "primary"} disabled={mutation.pending}>{mutation.pending ? "Please wait…" : action === "rotate" ? "Rotate secret" : "Delete webhook"}</Button></fieldset></form>;
}

function WebhookSignature({ base }: { base: string }) {
  const resource = useWorkspaceResource<SignatureContract>(`${base}/signature-contract`);
  if (!resource.data) return <div className="developer-dialog-stack"><FormFeedback error={resource.error} />{resource.error ? <Button onClick={() => void resource.refresh().catch(() => {})}>Try again</Button> : <PanelMessage className="account-note" role="status">Loading signature policy…</PanelMessage>}</div>;
  const data = resource.data;
  return <div className="developer-dialog-stack"><dl className="account-detail-list"><div><dt>Algorithm</dt><dd>{data.algorithm}</dd></div><div><dt>Signature header</dt><dd><code>{data.signatureHeader}</code></dd></div><div><dt>Delivery header</dt><dd><code>{data.deliveryIdHeader}</code></dd></div><div><dt>Replay header</dt><dd><code>{data.replayCountHeader}</code></dd></div><div><dt>Key version header</dt><dd><code>{data.secretVersionHeader}</code></dd></div><div><dt>Timestamp tolerance</dt><dd>{data.toleranceSeconds} seconds</dd></div><div><dt>Attempts per run</dt><dd>{data.attemptsPerRun}</dd></div><div><dt>Retry delays</dt><dd>{data.backoffSeconds.join(", ")} seconds</dd></div><div><dt>Maximum replays</dt><dd>{data.maximumExplicitReplays}</dd></div></dl><p className="account-note">{data.signedContent}</p><pre className="account-event-metadata">{data.signatureFormat}</pre><p className="account-note">{data.secretEncoding}</p><p className="account-note">{data.verification}</p><p className="account-note">{data.deduplication}</p><p className="account-note">{data.retryPolicy}</p><p className="account-note">{data.replayDestination}</p><p className="account-note">{data.retention}</p></div>;
}
