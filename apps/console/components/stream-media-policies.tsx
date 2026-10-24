"use client";

import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";

import { useState, type FormEvent } from "react";
import { streamCommand } from "@/lib/stream-api";
import { formatBytes, formatTimecode } from "@/lib/streams";
import type { BufferPolicy, DvrPolicy, DvrPlayback, PolicyResource, RecordingPolicy, Stream } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { SettingsRow } from "@/ui/settings-row";
import { ReportMetric, ReportSection } from "@/ui/report-controls";

type PolicyKind = "recording" | "buffer" | "dvr" | "record-now";
export function StreamMediaPolicies({ stream }: { stream: Stream }) {
  const state = useStreams();
  const [dialog, setDialog] = useState<PolicyKind | null>(null), [busy, setBusy] = useState(false);
  const recording = useWorkspaceResource<PolicyResource<RecordingPolicy>>(state.path(`streams/${stream.id}/recording-policy`));
  const buffer = useWorkspaceResource<PolicyResource<BufferPolicy>>(state.path(`streams/${stream.id}/buffer-policy`));
  const dvr = useWorkspaceResource<PolicyResource<DvrPolicy>>(state.path(`streams/${stream.id}/dvr-policy`));
  const playback = useWorkspaceResource<DvrPlayback>(state.path(`streams/${stream.id}/dvr-playback`));
  useRealtimeRefresh(playback.refresh, !dialog);
  function close() { setDialog(null); void Promise.allSettled([recording.refresh(), buffer.refresh(), dvr.refresh(), playback.refresh()]); }
  const selected = dialog === "dvr" ? dvr : dialog === "buffer" ? buffer : recording;
  return <>
    <ReportSection title="Recording & DVR">
      <SettingsRow icon="recording" label="Recording policy" value={!recording.data ? recording.error ? "Unavailable" : "Loading…" : recording.data.policy?.mode === "automatic" ? "Automatic" : "Manual"} onClick={state.canManage ? () => setDialog("recording") : undefined} trailing={state.canManage ? undefined : <></>} />
      <SettingsRow icon="clip" label="Clip buffer" value={!buffer.data ? buffer.error ? "Unavailable" : "Loading…" : buffer.data.policy?.enabled ? `${buffer.data.policy.durationSeconds / 60} min` : "Off"} onClick={state.canManage ? () => setDialog("buffer") : undefined} trailing={state.canManage ? undefined : <></>} />
      <SettingsRow icon="history" label="DVR policy" value={!dvr.data ? dvr.error ? "Unavailable" : "Loading…" : dvr.data.policy?.enabled ? `${dvr.data.policy.durationSeconds / 60} min` : "Off"} onClick={state.canManage ? () => setDialog("dvr") : undefined} trailing={state.canManage ? undefined : <></>} />
      {playback.data && <><ReportMetric icon="history" label="DVR capture" value={playback.data.capture?.state.replaceAll("_", " ") ?? playback.data.state} />{playback.data.startSeconds !== null && playback.data.endSeconds !== null && <ReportMetric icon="history" label="Retained range" value={`${formatTimecode(playback.data.startSeconds)} – ${formatTimecode(playback.data.endSeconds)}`} />}<ReportMetric icon="usage" label="DVR storage" value={formatBytes(playback.data.storedBytes)} /></>}
    </ReportSection>
    <FormFeedback error={recording.error || buffer.error || dvr.error || playback.error} />
    {(recording.error || buffer.error || dvr.error || playback.error) && <Button className="workspace-section-button" onClick={close}>Reload media settings</Button>}
    <p className="account-section-note">Policies apply to the next broadcast. Disabling DVR drains the current window. Recording requires a running broadcast and acknowledged consent.</p>
    {state.canManage && <Button className="workspace-section-button" icon="recording" onClick={() => setDialog("record-now")}>Start Recording</Button>}
    <Dialog open={Boolean(dialog)} title={dialog === "record-now" ? "Start Recording" : dialog === "recording" ? "Recording policy" : dialog === "buffer" ? "Clip buffer" : "DVR policy"} onClose={close} dismissible={!busy}>
      {dialog && (selected.data ? <MediaPolicyForm key={dialog} kind={dialog} stream={stream} current={selected.data} onBusy={setBusy} onSaved={close} /> : <div className="developer-dialog-stack"><FormFeedback error={selected.error} /><Button onClick={() => void selected.refresh().catch(() => {})}>{(selected.loading && !selected.data) ? "Loading policy…" : "Try again"}</Button></div>)}
    </Dialog>
  </>;
}
function MediaPolicyForm({ kind, stream, current, onBusy, onSaved }: { kind: PolicyKind; stream: Stream; current: PolicyResource<RecordingPolicy | BufferPolicy | DvrPolicy>; onBusy: (busy: boolean) => void; onSaved: () => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy), { notify } = useNotifications();
  const recording = current.policy && "mode" in current.policy ? current.policy : null;
  const rolling = current.policy && "enabled" in current.policy ? current.policy : null;
  const [enabled, setEnabled] = useState(rolling?.enabled ?? true);
  const [duration, setDuration] = useState(rolling?.durationSeconds ?? 300), [maxMiB, setMaxMiB] = useState((rolling?.maxBytes ?? 134217728) / 1048576);
  const [ended, setEnded] = useState(current.policy && "endedRetentionSeconds" in current.policy ? current.policy.endedRetentionSeconds : 300);
  const [mode, setMode] = useState(recording?.mode ?? "manual"), [region, setRegion] = useState(recording?.region ?? "us-east-1");
  const [maxMinutes, setMaxMinutes] = useState((recording?.maxDurationSeconds ?? 14400) / 60), [retentionDays, setRetentionDays] = useState((recording?.retentionSeconds ?? 604800) / 86400);
  const [allowPartial, setAllowPartial] = useState(recording?.allowPartial ?? false), [exportMp4, setExportMp4] = useState(recording?.exportMp4 ?? true), [segmentEvents, setSegmentEvents] = useState(recording?.segmentEvents ?? false);
  const [consent, setConsent] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    void mutation.run(async () => {
      if (!consent) throw new Error("Acknowledge recording consent before saving.");
      if (kind === "recording" || kind === "record-now") {
        const policy: RecordingPolicy = { mode: kind === "record-now" ? "manual" : mode, maxDurationSeconds: Math.round(maxMinutes * 60), retentionSeconds: Math.round(retentionDays * 86400), region: region.trim(), allowPartial, exportMp4, segmentEvents, consentAcknowledged: true };
        await streamCommand(state.path(`streams/${stream.id}/${kind === "record-now" ? "recordings" : "recording-policy"}`), kind === "record-now" ? { policy } : { policy, version: current.version }, kind === "record-now" ? "POST" : "PUT");
      } else {
        const policy = { enabled, durationSeconds: duration, maxBytes: Math.round(maxMiB * 1048576), consentAcknowledged: true, ...(kind === "dvr" ? { endedRetentionSeconds: ended } : {}) };
        await streamCommand(state.path(`streams/${stream.id}/${kind}-policy`), { policy, ...(kind === "buffer" || current.version > 0 ? { version: current.version } : {}) }, kind === "buffer" ? "PUT" : current.version ? "PATCH" : "POST");
      }
      notify(kind === "record-now" ? "Recording requested" : "Media policy saved"); onSaved();
    });
  }
  return <form className="account-form" onSubmit={submit}><fieldset disabled={mutation.pending}>
    {kind === "recording" || kind === "record-now" ? <>
      {kind === "recording" && <Field label="Recording mode"><Select className="input" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="manual">Manual</option><option value="automatic">Automatic on broadcast start</option></Select></Field>}
      <Field label="Storage region"><input className="input" value={region} onChange={event => setRegion(event.target.value)} required maxLength={64} pattern="[A-Za-z0-9_-]+" /></Field><p className="account-note">Use the storage region configured for your media service.</p>
      <div className="account-field-pair"><Field label="Maximum minutes"><input className="input" type="number" min={1} max={1440} step="any" required value={maxMinutes} onChange={event => setMaxMinutes(Number(event.target.value))} /></Field><Field label="Retention days"><input className="input" type="number" min={1 / 24} max={90} step="any" required value={retentionDays} onChange={event => setRetentionDays(Number(event.target.value))} /></Field></div>
      <label className="account-checkbox"><Checkbox type="checkbox" checked={exportMp4} onChange={event => setExportMp4(event.target.checked)} />Export MP4</label><label className="account-checkbox"><Checkbox type="checkbox" checked={allowPartial} onChange={event => setAllowPartial(event.target.checked)} />Allow partial recordings</label><label className="account-checkbox"><Checkbox type="checkbox" checked={segmentEvents} onChange={event => setSegmentEvents(event.target.checked)} />Emit segment webhook events</label>
    </> : <><label className="account-checkbox"><Checkbox type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled</label><Field label="Window (seconds)"><input className="input" type="number" min={30} max={1800} step={1} required value={duration} onChange={event => setDuration(Number(event.target.value))} /></Field><Field label="Storage cap (MiB)"><input className="input" type="number" min={16} max={511} step="any" required value={maxMiB} onChange={event => setMaxMiB(Number(event.target.value))} /></Field>{kind === "dvr" && <Field label="Retention after ending (seconds)"><input className="input" type="number" min={0} max={1800} step={1} required value={ended} onChange={event => setEnded(Number(event.target.value))} /></Field>}</>}
    <label className="account-checkbox"><Checkbox type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} required />I have the required consent to capture and retain this media.</label>
    <FormFeedback error={mutation.error} /><Button type="submit" variant="primary" disabled={!consent || !state.canManage}>{mutation.pending ? "Saving…" : kind === "record-now" ? "Start Recording" : "Save policy"}</Button>
  </fieldset></form>;
}
