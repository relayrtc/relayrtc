"use client";

import { PanelMessage } from "@/ui/panel-message";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";

import { useState } from "react";
import { streamCommand } from "@/lib/stream-api";
import type { Destination, Page } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { SettingsRow } from "@/ui/settings-row";
import { ReportSection } from "@/ui/report-controls";

export function StreamDestinations({ streamId }: { streamId: string }) {
  const state = useStreams();
  const [cursor, setCursor] = useState(""), [selected, setSelected] = useState<Destination | "new" | null>(null), [busy, setBusy] = useState(false);
  const resource = useWorkspaceResource<Page<Destination>>(state.path(`streams/${streamId}/destinations`, { limit: "30", ...(cursor ? { cursor } : {}) }));
  function close() { setSelected(null); void resource.refresh().catch(() => {}); }
  return <>
    <ReportSection title="Stream destinations">{resource.data?.data.length ? resource.data.data.map(item => <SettingsRow key={item.id} icon="egress" label={item.name} value={item.enabled ? item.host : "Disabled"} onClick={state.canManage ? () => setSelected(item) : undefined} trailing={state.canManage ? undefined : <></>} />) : <PanelMessage className="media-panel-note">{(resource.loading && !resource.data) ? "Loading destinations…" : "No destinations configured."}</PanelMessage>}</ReportSection>
    <FormFeedback error={resource.error} />{resource.error && <Button className="workspace-section-button" onClick={() => void resource.refresh().catch(() => {})}>Reload destinations</Button>}
    {resource.data?.nextCursor && <Button className="workspace-section-button" disabled={resource.loading} onClick={() => setCursor(resource.data!.nextCursor!)}>More destinations</Button>}{cursor && <button className="auth-text-button" onClick={() => setCursor("")}>First page</button>}
    {state.canManage && <Button icon="plus" className="workspace-section-button" onClick={() => setSelected("new")}>Add Destination</Button>}
    <Dialog open={Boolean(selected)} title={selected === "new" ? "Add Destination" : "Destination settings"} onClose={close} dismissible={!busy}>{selected && <DestinationForm key={selected === "new" ? "new" : `${selected.id}:${selected.version}`} streamId={streamId} destination={selected === "new" ? undefined : selected} onBusy={setBusy} onSaved={close} />}</Dialog>
  </>;
}
function DestinationForm({ streamId, destination, onBusy, onSaved }: { streamId: string; destination?: Destination; onBusy: (busy: boolean) => void; onSaved: () => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const [step, setStep] = useState<"edit" | "rotate" | "delete">("edit");
  const [name, setName] = useState(destination?.name ?? ""), [endpoint, setEndpoint] = useState(""), [secret, setSecret] = useState(""), [profile, setProfile] = useState(destination?.profile ?? "remux"), [enabled, setEnabled] = useState(destination?.enabled ?? true), [confirmation, setConfirmation] = useState("");
  const root = `streams/${streamId}/destinations${destination ? `/${destination.id}` : ""}`;
  return <form className="account-form" onSubmit={event => { event.preventDefault(); void mutation.run(async () => {
    if (step === "delete") { if (confirmation !== destination?.name) throw new Error("Enter the destination name to confirm."); await streamCommand(state.path(root), {}, "DELETE"); }
    else if (step === "rotate" && destination) await streamCommand(state.path(`${root}/rotate-secret`), { version: destination.version, streamKey: secret });
    else await streamCommand(state.path(root), { name: name.trim(), profile, enabled, ...(destination ? { version: destination.version, ...(endpoint ? { endpoint } : {}) } : { endpoint, streamKey: secret }) }, destination ? "PATCH" : "POST");
    setSecret(""); onSaved();
  }); }}><fieldset disabled={mutation.pending}>
    {step === "edit" ? <><Field label="Destination name"><input className="input" autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></Field><Field label={destination ? "Replace RTMP/RTMPS endpoint (optional)" : "RTMP/RTMPS endpoint"}><input className="input" placeholder="rtmps://live.example.com/app" value={endpoint} onChange={event => setEndpoint(event.target.value)} required={!destination} maxLength={512} /></Field><p className="account-note">Use an application URL on port 1935, 1936, or 443. Keep the stream key separate.</p>{!destination && <Field label="Stream key"><input className="input" type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={1024} /></Field>}<Field label="Output profile"><Select className="input" value={profile} onChange={event => setProfile(event.target.value as typeof profile)}><option value="remux">Remux</option><option value="720p">720p</option><option value="1080p">1080p</option></Select></Field><label className="account-checkbox"><Checkbox type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled for future broadcasts</label></> : step === "rotate" ? <><p className="account-note">Replace the stored destination key. New broadcasts use the replacement.</p><Field label="New stream key"><input className="input" type="password" autoComplete="new-password" required maxLength={1024} value={secret} onChange={event => setSecret(event.target.value)} /></Field></> : <><p className="account-note">Delete this destination and its stored credentials. Existing broadcast snapshots may still reference it.</p><Field label={`Type “${destination?.name}” to confirm`}><input className="input" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></Field></>}
    <FormFeedback error={mutation.error} /><Button type="submit" variant={step === "delete" ? "danger" : "primary"} disabled={!state.canManage || (step === "delete" && confirmation !== destination?.name)}>{mutation.pending ? "Saving…" : step === "delete" ? "Delete Destination" : step === "rotate" ? "Replace key" : "Save Destination"}</Button>
    {destination && step === "edit" && <><Button type="button" onClick={() => setStep("rotate")}>Replace stream key</Button><Button type="button" variant="danger" onClick={() => setStep("delete")}>Delete Destination</Button></>}{step !== "edit" && <Button type="button" onClick={() => { setStep("edit"); setSecret(""); }}>Back</Button>}
  </fieldset></form>;
}
