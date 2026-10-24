"use client";

import { PanelMessage } from "@/ui/panel-message";

import { useEffect, useRef, useState } from "react";
import { accountRequest, errorMessage } from "@/lib/account-api";
import { workspaceApi, workspacePath } from "@/lib/workspace-api";
import type { DeletionImpact, DeletionKind, DeletionOperation, DeletionResult } from "@/lib/workspace-types";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Field, FormFeedback } from "@/ui/auth-fields";

export function ResourceDeletionDialog({ open, kind, resource, projectId, onClose, onComplete }: {
  open: boolean; kind: DeletionKind; resource: { id: string; name: string; status: string }; projectId?: string; onClose: () => void; onComplete: () => void;
}) {
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [operation, setOperation] = useState<DeletionOperation | null>(null);
  const [requested, setRequested] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const callback = useRef(onComplete);
  const completed = useRef(false);
  const lock = useRef(false);
  useEffect(() => { callback.current = onComplete; }, [onComplete]);
  const base = kind === "organization" ? workspacePath("organizations", resource.id) : kind === "project" ? workspacePath("projects", resource.id) : `${workspacePath("projects", projectId ?? "")}/environments/${encodeURIComponent(resource.id)}`;
  const progressPath = `${workspaceApi}/deletions?${new URLSearchParams({ kind, resourceId: resource.id })}`;

  useEffect(() => {
    if (!open) return;
    let active = true; const controller = new AbortController();
    completed.current = false; setImpact(null); setOperation(null); setRequested(resource.status === "deleting"); setConfirmation(""); setError(""); setLoading(true);
    void (async () => {
      try {
        const result = await accountRequest<DeletionResult>(progressPath, undefined, controller.signal);
        if (!active) return;
        if (result.operation) {
          setOperation(result.operation); setRequested(true);
          if (result.operation.status === "completed" && !completed.current) { completed.current = true; callback.current(); }
        } else if (kind !== "environment" && resource.status !== "deleting") {
          const next = await accountRequest<DeletionImpact>(`${base}/deletion-impact`, undefined, controller.signal);
          if (active) setImpact(next);
        }
      } catch (error) { if (active) setError(errorMessage(error)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [open, kind, resource.id, resource.status, base, progressPath]);

  useEffect(() => {
    if (!open || !requested || operation?.status === "completed") return;
    let active = true; let running = false; const controller = new AbortController();
    const poll = async () => {
      if (running) return; running = true;
      try {
        const result = await accountRequest<DeletionResult>(progressPath, undefined, controller.signal);
        if (active) {
          setOperation(result.operation); setError("");
          if (result.operation?.status === "completed" && !completed.current) { completed.current = true; callback.current(); }
        }
      } catch (error) { if (active) setError(errorMessage(error)); }
      finally { running = false; }
    };
    const timer = setInterval(() => void poll(), 3000);
    return () => { active = false; clearInterval(timer); controller.abort(); };
  }, [open, requested, operation?.status, progressPath]);

  async function remove() {
    if (lock.current || confirmation !== resource.name || loading || requested || (kind !== "environment" && !impact)) return;
    lock.current = true; setPending(true); setError("");
    try {
      const result = await accountRequest<DeletionResult>(`${base}/delete`, kind === "environment" ? {} : { confirmationName: confirmation });
      setRequested(true); setOperation(result.operation);
      if (result.operation?.status === "completed" && !completed.current) { completed.current = true; callback.current(); }
    } catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setPending(false); }
  }

  return <Dialog open={open} title={requested ? "Deletion progress" : `Delete ${resource.name}?`} dismissible={!pending} onClose={onClose}>
    <div className="form-stack"><FormFeedback error={error} />{loading ? <PanelMessage className="account-note" role="status">Loading deletion details…</PanelMessage> : requested ? <>
      <p className="account-note" role="status">{operation?.status === "completed" ? "Deletion completed." : operation?.status === "failed" ? "Cleanup will retry automatically. You can close this dialog." : "Your resources are being disconnected and cleaned up. You can close this dialog; cleanup continues in the background."}</p>
      <dl className="account-detail-list"><div><dt>Status</dt><dd>{operation?.status ?? "Pending"}</dd></div><div><dt>Attempts</dt><dd>{operation?.attempts ?? 0}</dd></div></dl>
    </> : <><p className="account-note">This permanently removes this {kind} and its resources. Connected participants will be disconnected. Usage and audit history follow the existing retention policy.</p>
      {impact && <dl className="account-detail-list">{(Object.entries({ Projects: impact.projects, Environments: impact.environments, "API keys": impact.apiKeys, Rooms: impact.rooms, "Rooms to end": impact.roomsToEnd, "Connected participants": impact.connectedParticipants })).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      <Field label={`Type ${resource.name} to confirm`}><input className="input" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" disabled={pending || (kind !== "environment" && !impact)} /></Field>
      <Button variant="danger" disabled={pending || confirmation !== resource.name || (kind !== "environment" && !impact)} onClick={() => void remove()}>{pending ? "Requesting deletion…" : `Delete ${kind}`}</Button>
    </>}<Button disabled={pending} onClick={onClose}>{requested ? "Close" : "Cancel"}</Button></div>
  </Dialog>;
}
