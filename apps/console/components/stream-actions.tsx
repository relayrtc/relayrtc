"use client";

import { Select } from "@/ui/select";

import { useState, type FormEvent } from "react";
import { streamCommand } from "@/lib/stream-api";
import type { IngestCredential, MediaGrant, Stream, StreamingOperation } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useDeveloperMutation } from "./use-developer-mutation";
import { Button } from "@/ui/button";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { OneTimeSecret } from "@/ui/developer-fields";
import { MediaCopy, MediaGrantLink } from "@/ui/media-controls";
import { formatRoomTime } from "@/lib/rooms";

export type StreamAction = "setup" | "playback" | "dvr" | "stop" | "delete" | "revoke";
export function StreamActionForm({ stream, action, onBusy, onDone, onOperation }: { stream: Stream; action: StreamAction; onBusy: (busy: boolean) => void; onDone: () => void; onOperation: (operation: StreamingOperation) => void }) {
  const state = useStreams(), mutation = useDeveloperMutation(onBusy);
  const [ttl, setTtl] = useState(action === "setup" ? 3600 : 300), [confirmation, setConfirmation] = useState("");
  const [credential, setCredential] = useState<IngestCredential | null>(null), [grant, setGrant] = useState<MediaGrant | null>(null);
  const [rotateId, setRotateId] = useState("");
  const credentials = useWorkspaceResource<{ data: { id: string; expiresAt: string; revokedAt: string | null }[] }>(action === "setup" ? state.path(`streams/${stream.id}/ingest-credentials`) : null);
  function submit(event: FormEvent) {
    event.preventDefault();
    void mutation.run(async () => {
      if (action === "setup") {
        const result = await streamCommand<IngestCredential>(state.path(`streams/${stream.id}/ingest-credentials${rotateId ? `/${rotateId}/rotate` : ""}`), { ttlSeconds: ttl });
        setCredential(result);
      } else if (action === "playback" || action === "dvr") {
        const value = await streamCommand<MediaGrant>(state.path(`streams/${stream.id}/playback-grants`), { ttlSeconds: ttl, mode: action === "dvr" ? "dvr" : "live" });
        setGrant(value);
      } else {
        if (confirmation !== stream.name) throw new Error("Enter the exact stream name to confirm.");
        if (action === "revoke") { await streamCommand(state.path(`streams/${stream.id}/playback-grants/revoke`)); onDone(); return; }
        const operation = await streamCommand<StreamingOperation>(state.path(`streams/${stream.id}${action === "stop" ? "/stop" : ""}`), {}, action === "delete" ? "DELETE" : "POST");
        onOperation(operation); onDone();
      }
    });
  }
  if (credential) {
    const publishUrl = credential.protocol === "rtmp" ? new URL(credential.url) : null;
    const streamKey = publishUrl ? `${publishUrl.pathname.slice(1)}?pass=${encodeURIComponent(credential.secret)}` : credential.secret;
    return <div className="developer-dialog-stack"><p className="account-note">Expires {formatRoomTime(credential.expiresAt)}. {credential.handover?.status === "pending" ? "The previous publisher is disconnecting. Wait before reconnecting." : "Keep these encoder credentials private."}</p><MediaCopy value={publishUrl ? `${publishUrl.protocol}//${publishUrl.host}` : credential.url} label={publishUrl ? "RTMP server" : "WHIP endpoint"} /><p className="account-note">{publishUrl ? "Use the server and stream key below in OBS or your encoder." : "Send the secret below as the encoder’s Bearer token."}</p><OneTimeSecret value={streamKey} label={publishUrl ? "Stream key" : "Bearer token"} onDone={onDone} /></div>;
  }
  if (grant) return <div className="developer-dialog-stack"><MediaGrantLink grant={grant} label={action === "dvr" ? "Open DVR playback" : "Open live playback"} /><Button onClick={() => setGrant(null)}>Generate another link</Button><Button onClick={onDone}>Done</Button></div>;
  return <form className="account-form" onSubmit={submit}><fieldset disabled={mutation.pending}>
    {action === "setup" ? <><Field label="Credential"><Select className="input" value={rotateId} onChange={event => setRotateId(event.target.value)}><option value="">Issue a new credential</option>{credentials.data?.data.filter(item => !item.revokedAt && Date.parse(item.expiresAt) > Date.now()).map(item => <option key={item.id} value={item.id}>Rotate {item.id.slice(-8)} · expires {formatRoomTime(item.expiresAt)}</option>)}</Select></Field><FormFeedback error={credentials.error} />{credentials.error && <Button type="button" onClick={() => void credentials.refresh().catch(() => {})}>Reload credentials</Button>}<p className="account-note">Up to five active credentials per stream. Rotating a credential disconnects its current publisher; reconnect with the new credential.</p></> : null}
    {action === "stop" || action === "delete" || action === "revoke" ? <><p className="account-note">{action === "revoke" ? "Revoke all currently issued stream playback links. Viewers need a new grant to continue." : action === "delete" ? "Deletion stops this stream and revokes its ingest credentials and playback links. Cleanup runs in the background." : "Stop the source and disconnect its publisher. Playback links are revoked. You can start a new session afterward."}</p><Field label={`Type “${stream.name}” to confirm`}><input className="input" autoFocus autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></Field></> : <Field label="Expires after (seconds)"><input className="input" type="number" min={action === "setup" ? 60 : 30} max={action === "setup" ? 86400 : 3600} step={1} required value={ttl} onChange={event => setTtl(Number(event.target.value))} /></Field>}
    <FormFeedback error={mutation.error} /><Button type="submit" variant={action === "delete" || action === "revoke" ? "danger" : "primary"} disabled={!state.canManage || ((action === "stop" || action === "delete" || action === "revoke") && confirmation !== stream.name)}>{mutation.pending ? "Requesting…" : action === "setup" ? rotateId ? "Rotate credential" : "Create credential" : action === "delete" ? "Delete Stream" : action === "stop" ? "Stop source" : action === "revoke" ? "Revoke playback links" : "Generate playback link"}</Button>
  </fieldset></form>;
}
