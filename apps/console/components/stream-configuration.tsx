"use client";

import { Checkbox } from "@/ui/checkbox";
import { Select } from "@/ui/select";

import { useState } from "react";
import type { Stream } from "@/lib/stream-types";
import { streamCommand } from "@/lib/stream-api";
import { useStreams } from "./streams-provider";
import { useDeveloperMutation } from "./use-developer-mutation";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Button } from "@/ui/button";

export function StreamConfiguration({ stream, onBusy, onSaved }: { stream: Stream; onBusy: (busy: boolean) => void; onSaved: () => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const [name, setName] = useState(stream.name), [profile, setProfile] = useState(stream.profile);
  const [duration, setDuration] = useState(stream.maxDurationSeconds), [retention, setRetention] = useState(stream.retentionSeconds);
  const [videoTracks, setVideoTracks] = useState(stream.source.kind === "room" ? stream.source.videoTrackIds.join(", ") : ""), [audioTracks, setAudioTracks] = useState(stream.source.kind === "room" ? stream.source.audioTrackIds.join(", ") : "");
  const trackIds = (value: string) => value.split(",").map(id => id.trim()).filter(Boolean);
  return <form className="account-form" onSubmit={event => { event.preventDefault(); void mutation.run(async () => {
    await streamCommand(state.path(`streams/${stream.id}`), { name: name.trim(), profile, maxDurationSeconds: duration, retentionSeconds: retention, version: stream.version, ...(stream.source.kind === "room" ? { source: { ...stream.source, videoTrackIds: trackIds(videoTracks), audioTrackIds: trackIds(audioTracks) } } : {}) }, "PATCH"); onSaved();
  }); }}><fieldset disabled={mutation.pending}>
    <p className="account-note">Stop the source before changing its configuration. Saving revokes existing playback grants.</p><Field label="Stream name"><input className="input" autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></Field>
    <label className="account-checkbox"><Checkbox type="checkbox" checked={profile.audioOnly} onChange={event => setProfile({ ...profile, audioOnly: event.target.checked })} />Audio only</label>
    <div className="account-field-pair"><Field label="Width"><input className="input" type="number" min={320} max={1920} step={2} required value={profile.width} onChange={event => setProfile({ ...profile, width: Number(event.target.value) })} /></Field><Field label="Height"><input className="input" type="number" min={180} max={1080} step={2} required value={profile.height} onChange={event => setProfile({ ...profile, height: Number(event.target.value) })} /></Field></div>
    <Field label="Frames per second"><input className="input" type="number" min={15} max={30} step={1} required value={profile.fps} onChange={event => setProfile({ ...profile, fps: Number(event.target.value) })} /></Field>
    <div className="account-field-pair"><Field label="Video bitrate (bps)"><input className="input" type="number" min={200000} max={6000000} step={1} required value={profile.videoBitrate} onChange={event => setProfile({ ...profile, videoBitrate: Number(event.target.value) })} /></Field><Field label="Audio bitrate (bps)"><input className="input" type="number" min={64000} max={192000} step={1} required value={profile.audioBitrate} onChange={event => setProfile({ ...profile, audioBitrate: Number(event.target.value) })} /></Field></div>
    <Field label="Layout"><Select className="input" value={profile.layout} onChange={event => setProfile({ ...profile, layout: event.target.value as "single" | "grid" })}><option value="single">Single</option><option value="grid">Grid</option></Select></Field>
    {stream.source.kind === "room" && <><Field label="Video track IDs (optional, comma separated)"><input className="input" value={videoTracks} onChange={event => setVideoTracks(event.target.value)} /></Field><Field label="Audio track IDs (optional, comma separated)"><input className="input" value={audioTracks} onChange={event => setAudioTracks(event.target.value)} /></Field></>}
    <Field label="Maximum duration (seconds)"><input className="input" type="number" min={60} max={86400} step={1} required value={duration} onChange={event => setDuration(Number(event.target.value))} /></Field><Field label="Live retention (seconds)"><input className="input" type="number" min={60} max={86400} step={1} required value={retention} onChange={event => setRetention(Number(event.target.value))} /></Field>
    <FormFeedback error={mutation.error} /><Button type="submit" variant="primary" disabled={!state.canManage}>{mutation.pending ? "Saving…" : "Save configuration"}</Button>
  </fieldset></form>;
}
