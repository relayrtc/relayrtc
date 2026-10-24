"use client";

import { PanelMessage } from "@/ui/panel-message";
import { Checkbox } from "@/ui/checkbox";
import { Select } from "@/ui/select";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";
import { accountRequest } from "@/lib/account-api";
import { resourceName } from "@/lib/workspace-api";
import { accountTime } from "@/lib/account-display";
import { apiKeyStatus, developerPath, projectHref } from "@/lib/developer-api";
import type { ApiKey, DeveloperProject, RevealedApiKey } from "@/lib/developer-types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { DeveloperChoices, DeveloperEnvironment, OneTimeSecret } from "@/ui/developer-fields";
import { Icon } from "@/ui/icon";
import { WorkspaceState } from "@/ui/workspace-state";

type View = "create" | "details" | "rotate" | "revoke";

export function DeveloperApiKeys({ projectId }: { projectId: string }) {
  const resource = useWorkspaceResource<DeveloperProject>(developerPath(projectId));
  const keys = useWorkspaceResource<{ apiKeys: ApiKey[] }>(`${developerPath(projectId)}/api-keys`);
  const [environmentId, setEnvironmentId] = useState("");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<View | null>(null);
  const [selected, setSelected] = useState<ApiKey>();
  const [busy, setBusy] = useState(false);
  const { notify } = useNotifications();
  if (!resource.data) return <WorkspaceState error={resource.error} title="Loading API keys" onRetry={() => { void resource.refresh().catch(() => {}); void keys.refresh().catch(() => {}); }} />;
  const details = resource.data;
  const environments = details.environments.filter(item => item.status === "active");
  const active = environments.find(item => item.id === environmentId) ?? environments.find(item => item.type === "development") ?? environments[0];
  const canManage = details.canManage && details.project.status === "active";
  const visible = keys.data?.apiKeys.filter(item => item.environmentId === active?.id && `${item.name} ${item.prefix} ${apiKeyStatus(item)}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <section className="content account-content" aria-label="API keys"><Link className="account-back" href={`${projectHref(projectId)}/developer`}><Icon name="chevronLeft" size={15.75} />Developer Controls</Link><DeveloperEnvironment environments={environments} value={active?.id ?? ""} onChange={setEnvironmentId} disabled={busy} /><input className="input workspace-search" type="search" placeholder="Search API keys" aria-label="Search API keys" value={search} onChange={event => setSearch(event.target.value)} /><section className="settings-section"><h2>API keys</h2><div className="panel">{visible.map(item => <button className="account-list-row" key={item.id} onClick={() => { setSelected(item); setDialog("details"); }}><span className="account-list-icon"><Icon name="secretKeys" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{item.name}</span><span className="account-list-description">{item.prefix}… · {item.type === "secret" ? "Secret" : "Publishable"}</span></span><span className={`account-outcome ${apiKeyStatus(item) === "Revoked" ? "developer-badge-muted" : ""}`}>{apiKeyStatus(item)}</span><Icon name="chevronRight" size={15.75} className="muted" /></button>)}{!visible.length && <PanelMessage className="account-panel-message" role="status">{(keys.loading && !keys.data) ? "Loading API keys…" : keys.error ? "API keys unavailable." : search ? "No matching API keys." : "No API keys in this environment."}</PanelMessage>}</div><FormFeedback error={keys.error} />{keys.error && <Button className="workspace-section-button" onClick={() => void keys.refresh().catch(() => {})}>Try again</Button>}<p className="account-section-note">{canManage ? "Secrets are shown once when created or rotated. Rotation immediately revokes the previous key." : "Owners and admins can create, rotate, and revoke API keys."}</p>{canManage && active && <Button className="workspace-section-button" icon="plus" onClick={() => { setSelected(undefined); setDialog("create"); }}>Create API key</Button>}</section><Dialog open={dialog !== null} title={dialog === "create" ? "Create API key" : "API key"} dismissible={!busy} onClose={() => setDialog(null)}>{dialog && active && <ApiKeyDialog key={`${dialog}:${selected?.id ?? active.id}`} view={dialog} apiKey={selected} details={details} environmentId={active.id} canManage={canManage} onBusy={setBusy} onClose={() => setDialog(null)} onChanged={message => { notify(message); void keys.refresh().catch(() => {}); }} />}</Dialog></section>;
}

function ApiKeyDialog({ view, apiKey, details, environmentId, canManage, onBusy, onClose, onChanged }: {
  view: View; apiKey?: ApiKey; details: DeveloperProject; environmentId: string; canManage: boolean;
  onBusy: (busy: boolean) => void; onClose: () => void; onChanged: (message: string) => void;
}) {
  const [step, setStep] = useState(view);
  const [type, setType] = useState<"secret" | "publishable">("secret");
  const [scopes, setScopes] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<string>();
  const mutation = useDeveloperMutation(onBusy);
  const base = `${developerPath(details.project.id)}/api-keys`;
  if (revealed) return <OneTimeSecret value={revealed} label="API key" onDone={onClose} />;
  if (step === "details" && apiKey) return <div className="developer-dialog-stack"><dl className="account-detail-list"><div><dt>Name</dt><dd>{apiKey.name}</dd></div><div><dt>Key ID</dt><dd><code>{apiKey.id}</code></dd></div><div><dt>Prefix</dt><dd><code>{apiKey.prefix}…</code></dd></div><div><dt>Type</dt><dd>{apiKey.type === "secret" ? "Secret" : "Publishable"}</dd></div><div><dt>Status</dt><dd>{apiKeyStatus(apiKey)}</dd></div><div><dt>Created</dt><dd>{accountTime(apiKey.createdAt)}</dd></div><div><dt>Last used</dt><dd>{apiKey.lastUsedAt ? accountTime(apiKey.lastUsedAt) : "Never"}</dd></div><div><dt>Expires</dt><dd>{apiKey.expiresAt ? accountTime(apiKey.expiresAt) : "Never"}</dd></div>{apiKey.revokedAt && <div><dt>Revoked</dt><dd>{accountTime(apiKey.revokedAt)}</dd></div>}<div><dt>Scopes</dt><dd>{apiKey.scopes.join(", ") || "No privileged scopes"}</dd></div></dl>{canManage && !apiKey.revokedAt && <div className="account-button-pair"><Button onClick={() => setStep("rotate")}>Rotate key</Button><Button variant="danger" onClick={() => setStep("revoke")}>Revoke key</Button></div>}</div>;
  if (step === "rotate" || step === "revoke") return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!apiKey || !canManage) return; void mutation.run(async () => { const result = await accountRequest<RevealedApiKey | ApiKey>(`${base}/${encodeURIComponent(apiKey.id)}/${step}`, {}); if (step === "rotate" && "rawKey" in result) setRevealed(result.rawKey); else onClose(); onChanged(step === "rotate" ? "API key rotated" : "API key revoked"); }); }}><fieldset disabled={mutation.pending || !canManage}><FormFeedback error={mutation.error} /><p className="account-note">{step === "rotate" ? `Rotate “${apiKey?.name}”? The current key stops working immediately. Save the replacement and update your integrations.` : `Revoke “${apiKey?.name}”? Requests using this key will stop working immediately.`}</p><label className="account-checkbox"><Checkbox type="checkbox" required />I understand the current key will stop working.</label><div className="account-button-pair"><Button type="button" onClick={() => setStep("details")}>Back</Button><Button type="submit" variant={step === "revoke" ? "danger" : "primary"} disabled={mutation.pending}>{mutation.pending ? "Please wait…" : step === "rotate" ? "Rotate key" : "Revoke key"}</Button></div></fieldset></form>;
  return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!canManage) return; const form = new FormData(event.currentTarget); void mutation.run(async () => { const days = Number(form.get("expiration")); const result = await accountRequest<RevealedApiKey>(base, { projectId: details.project.id, environmentId, name: resourceName(String(form.get("name"))), type, scopes: type === "secret" ? scopes : [], expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null }); setRevealed(result.rawKey); onChanged("API key created"); }); }}><fieldset disabled={mutation.pending || !canManage}><FormFeedback error={mutation.error} /><Field label="Name"><input className="input" name="name" maxLength={120} placeholder="Backend server" required autoFocus /></Field><div className="account-field-pair"><Field label="Type"><Select className="input" value={type} onChange={event => { setType(event.target.value as "secret" | "publishable"); setScopes([]); }}><option value="secret">Secret</option><option value="publishable">Publishable</option></Select></Field><Field label="Expiration"><Select className="input" name="expiration" defaultValue="90"><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="0">Never</option></Select></Field></div>{type === "secret" ? <DeveloperChoices label="Scopes" options={details.availableScopes} value={scopes} onChange={setScopes} disabled={mutation.pending} /> : <p className="account-note">Publishable keys identify this environment and have no privileged scopes.</p>}<p className="account-note">This key can only access {details.environments.find(item => item.id === environmentId)?.name ?? "the selected environment"} in {details.project.name}.</p><Button type="submit" variant="primary" disabled={mutation.pending}>{mutation.pending ? "Creating…" : "Create API key"}</Button></fieldset></form>;
}
