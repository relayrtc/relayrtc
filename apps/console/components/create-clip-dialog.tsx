"use client";

import { Select } from "@/ui/select";
import { AnimatedValue } from "@/ui/sliding-number";

import { useEffect, useState, type FormEvent } from "react";
import { accountRequest } from "@/lib/account-api";
import { streamCommand } from "@/lib/stream-api";
import { formatTimecode } from "@/lib/streams";
import type { Clip, ClipWindow, Page, Stream } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";

export function CreateClipDialog({ open, sourceId, streamId, onClose, onCreated }: { open: boolean; sourceId?: string; streamId?: string; onClose: () => void; onCreated: (clip: Clip) => void }) {
  const [busy, setBusy] = useState(false);
  return <Dialog open={open} title="Create Clip" description="Save a moment from retained recordings or a live buffer." onClose={onClose} dismissible={!busy}>{open && <ClipForm open={open} sourceId={sourceId} streamId={streamId} onBusy={setBusy} onCreated={clip => { onClose(); onCreated(clip); }} />}</Dialog>;
}
export function ClipForm({ sourceId, streamId, onCreated, onBusy }: { open: boolean; sourceId?: string; streamId?: string; onCreated: (clip: Clip) => void; onBusy?: (busy: boolean) => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const [selectedStream, setSelectedStream] = useState(streamId ?? "");
  const [cursor, setCursor] = useState(""), [streamOptions, setStreamOptions] = useState<Stream[]>([]);
  const streamPage = useWorkspaceResource<Page<Stream>>(!streamId ? state.path("streams", { limit: "100", ...(cursor ? { cursor } : {}) }) : null);
  useEffect(() => { if (streamPage.data) setStreamOptions(current => [...new Map([...current, ...streamPage.data!.data].map(item => [item.id, item])).values()]); }, [streamPage.data]);
  const windows = useWorkspaceResource<{ data: ClipWindow[] }>(selectedStream ? state.path(`streams/${selectedStream}/clip-window`) : null);
  const [name, setName] = useState(""), [recordingId, setRecordingId] = useState(sourceId ?? "");
  const [start, setStart] = useState("0"), [end, setEnd] = useState("30");
  const [mode, setMode] = useState<"keyframe" | "precise">("keyframe");
  const [retentionDays, setRetentionDays] = useState(7);
  const selected = windows.data?.data.find(item => item.recordingId === recordingId);
  function chooseSource(item: ClipWindow) {
    const finish = item.kind === "buffer" ? item.endSeconds : Math.min(item.endSeconds, item.startSeconds + 30);
    setRecordingId(item.recordingId); setStart(String(Math.max(item.startSeconds, finish - 30))); setEnd(String(finish));
  }
  useEffect(() => {
    if (!windows.data) return;
    const initial = windows.data.data.find(item => item.recordingId === sourceId) ?? windows.data.data[0];
    if (initial) chooseSource(initial);
    else setRecordingId("");
  }, [windows.data, sourceId]);
  function submit(event: FormEvent) {
    event.preventDefault();
    void mutation.run(async () => {
      // The rolling buffer can move while a form is open. Re-read committed
      // segment bounds before submitting; the service validates them again.
      const fresh = await accountRequest<{ data: ClipWindow[] }>(state.path(`streams/${selectedStream}/clip-window`));
      const source = fresh.data.find(item => item.recordingId === recordingId);
      const from = Number(start), to = Number(end);
      if (!source || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < source.startSeconds || to > source.endSeconds) throw new Error("This range is no longer retained. Reload the source and choose an available range.");
      if (to - from > 120) throw new Error("Clips can be up to 120 seconds. The operator may set a lower limit.");
      const clip = await streamCommand<Clip>(state.path(`streams/${selectedStream}/clips`), { recordingId, interval: { kind: "media", startSeconds: from, endSeconds: to }, label: name.trim(), cutMode: mode, retentionSeconds: retentionDays * 86400 });
      onCreated(clip);
    });
  }
  return <form className="account-form" onSubmit={submit}><fieldset disabled={mutation.pending}>
    <Field label="Clip name"><input className="input" autoFocus maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Session highlights" required /></Field>
    {!streamId && <><Field label="Stream"><Select className="input" value={selectedStream} onChange={event => { setSelectedStream(event.target.value); setRecordingId(""); }} required><option value="">Choose a stream</option>{streamOptions.filter(item => item.status === "active").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><FormFeedback error={streamPage.error} />{streamPage.error && <Button type="button" onClick={() => void streamPage.refresh().catch(() => {})}>Retry streams</Button>}{streamPage.data?.nextCursor && <Button type="button" disabled={streamPage.loading} onClick={() => setCursor(streamPage.data!.nextCursor!)}>Load more streams</Button>}</>}
    <Field label="Source"><Select className="input" required value={recordingId} onChange={event => { const item = windows.data?.data.find(item => item.recordingId === event.target.value); if (item) chooseSource(item); }}><option value="">Choose retained media</option>{windows.data?.data.map(item => <option key={item.recordingId} value={item.recordingId}>{item.kind === "buffer" ? "Live buffer" : "Recording"} · {item.recordingId}</option>)}</Select></Field>
    <FormFeedback error={windows.error} />
    {selectedStream && <Button type="button" disabled={windows.loading} onClick={() => void windows.refresh().catch(() => {})}>{(windows.loading && !windows.data) ? "Loading range…" : "Reload available ranges"}</Button>}
    {selected ? <p className="account-note">Available: <AnimatedValue value={formatTimecode(selected.startSeconds)} /> – <AnimatedValue value={formatTimecode(selected.endSeconds)} />{selected.kind === "buffer" ? " · Moving buffer window" : ""}</p> : <p className="account-note">Choose a stream with committed recording or buffer segments.</p>}
    <div className="account-field-pair"><Field label="Start (seconds)"><input className="input" type="number" min={selected?.startSeconds ?? 0} max={selected?.endSeconds} step="any" required value={start} onChange={event => setStart(event.target.value)} /></Field><Field label="End (seconds)"><input className="input" type="number" min={selected?.startSeconds ?? 0} max={selected?.endSeconds} step="any" required value={end} onChange={event => setEnd(event.target.value)} /></Field></div>
    <Field label="Cut mode"><Select className="input" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="keyframe">Keyframe aligned</option><option value="precise">Precise</option></Select></Field><p className="account-note">Keyframe cuts may extend to segment boundaries. Precise cuts render the requested range.</p>
    <Field label="Retention (days)"><input className="input" type="number" min={1} max={90} step={1} required value={retentionDays} onChange={event => setRetentionDays(Number(event.target.value))} /></Field>
    <FormFeedback error={mutation.error} /><Button type="submit" variant="primary" disabled={!selected || !name.trim() || !state.canManage}>{mutation.pending ? "Queuing clip…" : "Create Clip"}</Button>
  </fieldset></form>;
}
