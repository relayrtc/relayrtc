"use client";

import { Select } from "@/ui/select";
import { AnimatedValue } from "@/ui/sliding-number";
import { PanelMessage } from "@/ui/panel-message";
import { Checkbox } from "@/ui/checkbox";

import { useEffect, useState, type FormEvent } from "react";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";
import { accountRequest, errorMessage } from "@/lib/account-api";
import { accountTime, humanizeAction } from "@/lib/account-display";
import type { DeliveryStatus, WebhookDelivery, WebhookDeliveryDetail, WebhookDeliveryList } from "@/lib/developer-types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";

const statuses: DeliveryStatus[] = ["pending", "delivering", "succeeded", "failed", "cancelled"];
const statusName = (status: DeliveryStatus) => status === "pending" ? "Queued" : humanizeAction(status);

function useDeliveryRefresh(refresh: (signal?: AbortSignal) => Promise<unknown>) {
  useEffect(() => {
    const controller = new AbortController(); let running = false;
    const timer = setInterval(() => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      void refresh(controller.signal).catch(() => {}).finally(() => { running = false; });
    }, 10000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [refresh]);
}

function Status({ status }: { status: DeliveryStatus }) {
  return <span className={`account-outcome ${status === "failed" ? "account-outcome-failure" : status === "cancelled" ? "developer-badge-muted" : ""}`}>{statusName(status)}</span>;
}

export function WebhookDeliveries({ base, canManage, endpointEnabled }: { base: string; canManage: boolean; endpointEnabled: boolean }) {
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const limit = 20;
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset), ...(status === "all" ? {} : { status }) });
  const resource = useWorkspaceResource<WebhookDeliveryList>(`${base}/deliveries?${query}`);
  useDeliveryRefresh(resource.refresh);
  const { notify } = useNotifications();
  const total = resource.data?.pagination.total ?? 0;
  return <section className="settings-section"><div className="account-section-heading"><h2>Deliveries</h2><button className="auth-text-button" onClick={() => void resource.refresh().catch(() => {})} disabled={resource.loading}>Refresh</button></div><div className="panel account-filter-form developer-delivery-filter"><Field label="Status"><Select className="input" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="all">All statuses</option>{statuses.map(item => <option key={item} value={item}>{statusName(item)}</option>)}</Select></Field></div><div className="panel">{resource.data?.deliveries.map(item => <button className="account-list-row" key={item.id} onClick={() => setSelected(item.id)}><span className="account-list-icon"><Icon name="history" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title developer-record-id">{item.eventId}</span><span className="account-list-description">{accountTime(item.createdAt)} · <AnimatedValue value={item.attemptCount} /> attempt{item.attemptCount === 1 ? "" : "s"}{item.replayCount ? ` · ${item.replayCount} replay${item.replayCount === 1 ? "" : "s"}` : ""}</span></span><Status status={item.status} /></button>)}{!resource.data?.deliveries.length && <PanelMessage className="account-panel-message" role="status">{(resource.loading && !resource.data) ? "Loading deliveries…" : resource.error ? "Delivery history unavailable." : "No deliveries found."}</PanelMessage>}</div><FormFeedback error={resource.error} />{resource.error && <Button className="workspace-section-button" onClick={() => void resource.refresh().catch(() => {})}>Try again</Button>}{(offset > 0 || total > limit) && <div className="account-pagination"><button className="icon-button" aria-label="Previous deliveries" disabled={resource.loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><Icon name="chevronLeft" size={15.75} /></button><span>{total ? `${Math.min(offset + 1, total)}–${Math.min(offset + limit, total)} of ${total}` : "No results"}</span><button className="icon-button" aria-label="Next deliveries" disabled={resource.loading || offset + limit >= total || offset + limit > 100000} onClick={() => setOffset(value => value + limit)}><Icon name="chevronRight" size={15.75} /></button></div>}<p className="account-section-note">Updates every 10 seconds while this page is visible. Select a delivery for its payload and attempt history.</p><Dialog open={selected !== null} title="Webhook delivery" dismissible={!busy} onClose={() => setSelected(null)}>{selected && <DeliveryDetail key={selected} path={`${base}/deliveries/${encodeURIComponent(selected)}`} canManage={canManage} endpointEnabled={endpointEnabled} onBusy={setBusy} onReplayed={() => { notify("Delivery queued for replay"); void resource.refresh().catch(() => {}); }} />}</Dialog></section>;
}

function DeliveryDetail({ path, canManage, endpointEnabled, onBusy, onReplayed }: { path: string; canManage: boolean; endpointEnabled: boolean; onBusy: (busy: boolean) => void; onReplayed: () => void }) {
  const resource = useWorkspaceResource<WebhookDeliveryDetail>(path);
  const mutation = useDeveloperMutation(onBusy);
  const [confirming, setConfirming] = useState(false);
  const [copyError, setCopyError] = useState("");
  const { notify } = useNotifications();
  useDeliveryRefresh(resource.refresh);
  if (!resource.data) return <div className="developer-dialog-stack"><FormFeedback error={resource.error} />{resource.error ? <Button onClick={() => void resource.refresh().catch(() => {})}>Try again</Button> : <PanelMessage className="account-note" role="status">Loading delivery…</PanelMessage>}</div>;
  const data = resource.data;
  const terminal = !["pending", "delivering"].includes(data.status);
  const canReplay = canManage && endpointEnabled && terminal && data.replayCount < 100;
  return <div className="developer-dialog-stack"><FormFeedback error={mutation.error || copyError} /><dl className="account-detail-list"><div><dt>Event</dt><dd>{data.event.type}</dd></div><div><dt>Status</dt><dd><Status status={data.status} /></dd></div><div><dt>Delivery ID</dt><dd><code>{data.id}</code></dd></div><div><dt>Event ID</dt><dd><code>{data.eventId}</code></dd></div><div><dt>Destination</dt><dd>{data.url}</dd></div><div><dt>Occurred</dt><dd>{accountTime(data.event.occurredAt)}</dd></div><div><dt>Created</dt><dd>{accountTime(data.createdAt)}</dd></div><div><dt>Run started</dt><dd>{accountTime(data.runStartedAt)}</dd></div><div><dt>Delivered</dt><dd>{data.deliveredAt ? accountTime(data.deliveredAt) : "Not delivered"}</dd></div><div><dt>Next attempt</dt><dd>{data.nextAttemptAt ? accountTime(data.nextAttemptAt) : "None"}</dd></div><div><dt>Total attempts</dt><dd><AnimatedValue value={data.attemptCount} /></dd></div><div><dt>Current run</dt><dd><AnimatedValue value={data.runAttemptCount} /> of 8 attempts</dd></div><div><dt>Replays</dt><dd><AnimatedValue value={data.replayCount} /> of 100</dd></div>{data.lastError && <div><dt>Last error</dt><dd>{data.lastError}</dd></div>}</dl><div className="account-section-heading"><span className="field-label">Payload</span><button className="auth-text-button" onClick={() => { void (async () => { try { await navigator.clipboard.writeText(data.rawBody); setCopyError(""); notify("Payload copied"); } catch (error) { setCopyError(errorMessage(error)); } })(); }}>Copy payload</button></div><pre className="account-event-metadata developer-payload">{data.rawBody}</pre><span className="field-label">Attempt history</span><div className="developer-attempts">{data.attempts.map(attempt => <details className="developer-attempt" key={attempt.id}><summary><span>Attempt {attempt.attemptNumber}</span><span>{attempt.httpStatus ?? humanizeAction(attempt.status)}</span></summary><dl className="account-detail-list"><div><dt>Status</dt><dd>{humanizeAction(attempt.status)}</dd></div><div><dt>Started</dt><dd>{accountTime(attempt.startedAt)}</dd></div><div><dt>Finished</dt><dd>{attempt.finishedAt ? accountTime(attempt.finishedAt) : "In progress"}</dd></div><div><dt>HTTP status</dt><dd>{attempt.httpStatus ?? "No response"}</dd></div><div><dt>Signing key</dt><dd>Version {attempt.signingSecretVersion}</dd></div><div><dt>Signature time</dt><dd>{accountTime(new Date(attempt.signatureTimestamp * 1000).toISOString())}</dd></div><div><dt>Replay count</dt><dd><AnimatedValue value={attempt.replayCount} /></dd></div>{attempt.errorCode && <div><dt>Error</dt><dd>{attempt.errorCode}</dd></div>}</dl></details>)}{!data.attempts.length && <p className="account-note">No attempts yet.</p>}</div>{canReplay && !confirming && <Button onClick={() => setConfirming(true)}>Replay delivery</Button>}{canReplay && confirming && <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutation.run(async () => { await accountRequest<WebhookDelivery>(`${path}/replay`, { expectedReplayCount: data.replayCount }); setConfirming(false); onReplayed(); await resource.refresh(); }); }}><fieldset disabled={mutation.pending}><p className="account-note">Replay this event using the endpoint’s current URL and signing secret? Your receiver may process the event again.</p><label className="account-checkbox"><Checkbox type="checkbox" required />I want to queue this delivery again.</label><div className="account-button-pair"><Button type="button" onClick={() => setConfirming(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={mutation.pending}>{mutation.pending ? "Queuing…" : "Queue replay"}</Button></div></fieldset></form>}{canManage && !canReplay && <p className="account-note">{!endpointEnabled ? "Enable the webhook before replaying deliveries." : !terminal ? "A delivery can be replayed after its current run finishes." : "This delivery has reached the replay limit."}</p>}</div>;
}
