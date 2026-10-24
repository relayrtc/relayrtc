"use client";

import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";

import { useState, type FormEvent } from "react";
import { defaultProfile, streamTypes } from "@/lib/streams";
import type { Stream, StreamType } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useRooms } from "./rooms-provider";
import { useDeveloperMutation } from "./use-developer-mutation";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";

export function CreateStreamDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (stream: Stream) => void }) {
  const [busy, setBusy] = useState(false);
  return <Dialog open={open} title="Create Stream" description="Choose how your stream comes in." onClose={onClose} dismissible={!busy}>{open && <CreateStreamForm onBusy={setBusy} onCreated={stream => { onClose(); onCreated(stream); }} />}</Dialog>;
}
function CreateStreamForm({ onBusy, onCreated }: { onBusy: (busy: boolean) => void; onCreated: (stream: Stream) => void }) {
  const state = useStreams(), rooms = useRooms(), mutation = useDeveloperMutation(onBusy);
  const [name, setName] = useState(""), [type, setType] = useState<StreamType>("whip"), [roomId, setRoomId] = useState("");
  const [audioOnly, setAudioOnly] = useState(false), [resolution, setResolution] = useState("720"), [layout, setLayout] = useState<"single" | "grid">("single");
  const [maxMinutes, setMaxMinutes] = useState(240);
  function submit(event: FormEvent) {
    event.preventDefault();
    void mutation.run(async () => {
      const profile = { ...defaultProfile, audioOnly, layout, width: resolution === "1080" ? 1920 : 1280, height: Number(resolution) };
      const stream = await state.addStream({ name, source: type === "room" ? { kind: type, roomId, videoTrackIds: [], audioTrackIds: [] } : { kind: type }, profile, maxDurationSeconds: maxMinutes * 60, retentionSeconds: 300 });
      onCreated(stream);
    });
  }
  return <form className="account-form" onSubmit={submit}><fieldset disabled={mutation.pending}>
    <Field label="Stream name"><input className="input" autoFocus autoComplete="off" placeholder="e.g. Studio broadcast" value={name} onChange={event => setName(event.target.value)} maxLength={120} required /></Field>
    <span className="field-label" id="stream-type-label">Stream type</span><div className="segmented-control stream-type-control" role="group" aria-labelledby="stream-type-label">{streamTypes.map(item => <button key={item.value} type="button" aria-pressed={type === item.value} className={type === item.value ? "segment-active" : ""} onClick={() => setType(item.value)}>{item.label}</button>)}</div>
    <p className="account-note">{type === "whip" ? "A WHIP session starts when your encoder connects." : type === "rtmp" ? "An RTMP session starts when OBS or your encoder connects." : "Broadcast audio and video from a room in this environment."}</p>
    {type === "room" && <><Field label="Room"><Select className="input" value={roomId} onChange={event => setRoomId(event.target.value)} required><option value="">Choose a room</option>{rooms.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</Select></Field><FormFeedback error={rooms.error} />{rooms.error && <Button type="button" onClick={() => void rooms.refresh().catch(() => {})}>Reload rooms</Button>}{rooms.hasMoreRooms && <Button type="button" disabled={rooms.roomsLoading} onClick={rooms.loadMoreRooms}>Load more rooms</Button>}{rooms.ready && !rooms.rooms.length && !rooms.error && <p className="account-note">Create a room in Rooms first.</p>}</>}
    <label className="account-checkbox"><Checkbox type="checkbox" checked={audioOnly} onChange={event => setAudioOnly(event.target.checked)} />Audio only</label>
    {!audioOnly && <Field label="Output resolution"><Select className="input" value={resolution} onChange={event => setResolution(event.target.value)}><option value="720">1280 × 720</option><option value="1080">1920 × 1080</option></Select></Field>}
    {type === "room" && <Field label="Layout"><Select className="input" value={layout} onChange={event => setLayout(event.target.value as "single" | "grid")}><option value="single">Single</option><option value="grid">Grid</option></Select></Field>}
    <Field label="Maximum duration (minutes)"><input className="input" type="number" min={1} max={1440} step={1} required value={maxMinutes} onChange={event => setMaxMinutes(Number(event.target.value))} /></Field>
    <p className="account-note">Configure recording, DVR, and clip buffering on the stream after creating it.</p><FormFeedback error={mutation.error} />
    <Button type="submit" variant="primary" disabled={!state.canManage || !name.trim() || (type === "room" && !roomId)}>{mutation.pending ? "Creating…" : "Create Stream"}</Button>
  </fieldset></form>;
}
