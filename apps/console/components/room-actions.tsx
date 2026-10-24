"use client";

import { Select } from "@/ui/select";

import { useRef, useState, type FormEvent } from "react";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { useDeveloperMutation } from "./use-developer-mutation";
import { useNotifications } from "./notification-provider";
import { accountRequest } from "@/lib/account-api";
import { accountTime } from "@/lib/account-display";
import { roomApiPath } from "@/lib/room-api";
import type { ParticipantToken, RoomOverviewData, RuntimeOperation } from "@/lib/room-types";
import { Button } from "@/ui/button";
import { DeveloperChoices, OneTimeSecret } from "@/ui/developer-fields";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { RoomRuntimeStatus } from "@/ui/room-runtime-status";

export function RoomTokenForm({ details, onBusy, onClose }: { details: RoomOverviewData; onBusy: (busy: boolean) => void; onClose: () => void }) {
  const [permissions, setPermissions] = useState<string[]>([]);
  const [token, setToken] = useState<ParticipantToken>();
  const mutation = useDeveloperMutation(onBusy);
  const { notify } = useNotifications();
  if (token) return <div className="developer-dialog-stack"><p className="account-note">Expires {accountTime(token.expiresAt)}. Use this token with your RTC client to join {details.room.name}.</p><OneTimeSecret value={token.token} label="Participant token" onDone={onClose} /></div>;
  return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const text = String(data.get("metadata") ?? "").trim();
      let metadata: Record<string, unknown> = {};
      if (text) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new Error("Metadata must be valid JSON."); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Metadata must be a JSON object.");
        metadata = parsed as Record<string, unknown>;
      }
      const result = await accountRequest<ParticipantToken>(`${roomApiPath(details.room.projectId, details.room.id)}/tokens`, {
        participantName: String(data.get("name")).trim(), ttlSeconds: Number(data.get("ttl")), permissions: ["room:join", ...permissions], metadata,
      });
      setToken(result); notify("Participant token created");
    });
  }}><fieldset disabled={mutation.pending || !details.canOperate}><FormFeedback error={mutation.error} /><Field label="Participant name"><input className="input" name="name" autoFocus required maxLength={120} placeholder="e.g. Alex" autoComplete="off" /></Field><Field label="Valid for"><Select className="input" name="ttl" defaultValue="600"><option value="60">1 minute</option><option value="300">5 minutes</option><option value="600">10 minutes</option><option value="1800">30 minutes</option><option value="3600">1 hour</option></Select></Field><DeveloperChoices label="Optional permissions" options={details.tokenPermissions.filter(item => item !== "room:join")} value={permissions} onChange={setPermissions} disabled={mutation.pending} /><details className="room-advanced"><summary>Metadata (optional)</summary><Field label="JSON metadata"><textarea className="input room-metadata-input" name="metadata" placeholder="{}" maxLength={10000} spellCheck={false} /></Field></details><p className="account-note">Room joining is always included. This creates a token for {details.environment.name}; a participant appears after their client connects.</p><Button variant="primary" type="submit" disabled={mutation.pending || !details.tokenSigningAvailable}>{mutation.pending ? "Creating…" : "Create participant token"}</Button></fieldset></form>;
}

export function EndRoomForm({ details, onBusy, onChanged, onClose }: { details: RoomOverviewData; onBusy: (busy: boolean) => void; onChanged: () => void; onClose: () => void }) {
  const base = roomApiPath(details.room.projectId, details.room.id);
  const [requested, setRequested] = useState(Boolean(details.operation) || details.room.status === "ended");
  const [submitted, setSubmitted] = useState<RuntimeOperation | null>(details.operation);
  const progress = useWorkspaceResource<{ operation: RuntimeOperation | null }>(requested ? `${base}/runtime-operation` : null);
  const operation = progress.data?.operation ?? submitted;
  const mutation = useDeveloperMutation(onBusy);
  const nameRef = useRef<HTMLInputElement>(null);
  useRealtimeRefresh(progress.refresh, requested && operation?.status !== "completed");
  if (requested) return <div className="developer-dialog-stack"><RoomRuntimeStatus operation={operation} /><FormFeedback error={progress.error} /><div className="account-button-pair"><Button onClick={() => void progress.refresh().catch(() => {})} disabled={progress.loading}>Refresh</Button><Button onClick={() => { onChanged(); onClose(); }}>Done</Button></div></div>;
  return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutation.run(async () => {
    const result = await accountRequest<{ operation: RuntimeOperation | null }>(`${base}/end`, { confirmationName: nameRef.current?.value ?? "" });
    setSubmitted(result.operation); setRequested(true); onChanged();
  }); }}><fieldset disabled={mutation.pending || !details.canOperate}><FormFeedback error={mutation.error} /><p className="account-note">End “{details.room.name}”? All participants will be disconnected and this room will stop accepting connections.</p><Field label="Enter the room name to confirm"><input className="input" ref={nameRef} required maxLength={120} autoComplete="off" autoFocus /></Field><Button type="submit" variant="danger" disabled={mutation.pending}>{mutation.pending ? "Ending room…" : "End room"}</Button></fieldset></form>;
}
