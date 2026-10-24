"use client";

import { useState, type FormEvent } from "react";
import { useRooms } from "./rooms-provider";
import { useDeveloperMutation } from "./use-developer-mutation";
import { maxRoomCapacity, maxRoomNameLength } from "@/lib/rooms";
import type { Room } from "@/lib/room-types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, FormFeedback } from "@/ui/auth-fields";

export function CreateRoomDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (room: Room) => void }) {
  const [busy, setBusy] = useState(false);
  return <Dialog open={open} title="Create Room" description="A space for your next conversation." dismissible={!busy} onClose={onClose}>
    {open && <CreateRoomForm onBusy={setBusy} onCreated={room => { onClose(); onCreated(room); }} />}
  </Dialog>;
}

function CreateRoomForm({ onBusy, onCreated }: { onBusy: (value: boolean) => void; onCreated: (room: Room) => void }) {
  const rooms = useRooms();
  const mutation = useDeveloperMutation(onBusy);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const metadataText = String(data.get("metadata") ?? "").trim();
      let metadata: Record<string, unknown> = {};
      if (metadataText) {
        let parsed: unknown;
        try { parsed = JSON.parse(metadataText); } catch { throw new Error("Metadata must be valid JSON."); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Metadata must be a JSON object.");
        metadata = parsed as Record<string, unknown>;
      }
      onCreated(await rooms.createRoom(String(data.get("name")), Number(data.get("capacity")), metadata));
    });
  }
  return <form className="account-form" onSubmit={submit}><fieldset disabled={mutation.pending || !rooms.canOperate}>
    <FormFeedback error={mutation.error} />
    <Field label="Room name"><input className="input" name="name" placeholder="e.g. Design sync" autoFocus maxLength={maxRoomNameLength} required autoComplete="off" /></Field>
    <Field label="Maximum participants"><input className="input" name="capacity" type="number" inputMode="numeric" min={1} max={maxRoomCapacity} step={1} defaultValue={100} required /></Field>
    <p className="room-field-hint">Choose a limit from 1 to 100,000 participants.</p>
    <p className="account-note">Environment: {rooms.environment?.name}. The room belongs to this environment.</p>
    <details className="room-advanced"><summary>Metadata (optional)</summary><Field label="JSON metadata"><textarea className="input room-metadata-input" name="metadata" placeholder="{}" maxLength={10000} spellCheck={false} /></Field></details>
    <Button variant="primary" type="submit" disabled={mutation.pending || !rooms.ready}>{mutation.pending ? "Creating…" : "Create Room"}</Button>
  </fieldset></form>;
}
