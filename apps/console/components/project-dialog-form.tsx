"use client";

import { Select } from "@/ui/select";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { accountRequest, errorMessage } from "@/lib/account-api";
import { resourceName, workspacePath } from "@/lib/workspace-api";
import type { ProjectDetails, ProjectEnvironment } from "@/lib/workspace-types";
import { Button } from "@/ui/button";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Switch } from "@/ui/switch";

export type ProjectDialog = "rename" | "create-environment" | "environment";
const slugFromName = (value: string) => value.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");

export function ProjectDialogForm({ view, details, environment, onBusy, onChanged }: {
  view: ProjectDialog; details: ProjectDetails; environment?: ProjectEnvironment; onBusy: (value: boolean) => void; onChanged: (message: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [slug, setSlug] = useState(environment?.slug ?? "");
  const [protectedEnvironment, setProtectedEnvironment] = useState(environment?.deletionProtected ?? false);
  const lock = useRef(false);
  const defaults = environment?.type === "development" || environment?.type === "production";
  const canManage = details.canManage && details.project.status !== "deleting" && (!environment || environment.status === "active");
  const creating = view === "create-environment";
  function form(children: ReactNode, task: (data: FormData) => Promise<void>) {
    return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault(); if (lock.current || !canManage) return;
      const data = new FormData(event.currentTarget); lock.current = true; setPending(true); onBusy(true); setError("");
      void task(data).catch(error => setError(errorMessage(error))).finally(() => { lock.current = false; setPending(false); onBusy(false); });
    }}><fieldset disabled={pending || !canManage}><FormFeedback error={error} />{children}</fieldset>{!canManage && <p className="account-note">Only organization owners and admins can change these settings.</p>}</form>;
  }
  if (view === "rename") return form(<><Field label="Project name"><input className="input" name="name" defaultValue={details.project.name} maxLength={120} autoFocus required /></Field><p className="account-note">Your project ID, slug, and existing integrations stay the same.</p><Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button></>, async data => {
    await accountRequest(`${workspacePath("projects", details.project.id)}/update`, { name: resourceName(String(data.get("name"))) });
    await onChanged("Project updated");
  });
  return form(<>
    <Field label="Environment name"><input className="input" name="name" defaultValue={environment?.name ?? ""} maxLength={120} required autoFocus /></Field>
    {!creating && <Field label="Slug"><input className="input" value={slug} onChange={event => setSlug(event.target.value)} maxLength={80} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="staging" required /></Field>}
    {creating ? <Field label="Type"><Select className="input" name="type" defaultValue="staging"><option value="staging">Staging</option><option value="preview">Preview</option><option value="custom">Custom</option></Select></Field> : <p className="account-note">Type: {environment?.type}</p>}
    <div className="workspace-protection"><span className="field-label">Deletion protection</span><Switch checked={defaults || protectedEnvironment} onChange={setProtectedEnvironment} disabled={defaults || !canManage || pending} label="Environment deletion protection" /></div>
    <p className="account-note">{defaults ? "Development and Production environments are always protected from deletion." : "Protected environments must be unprotected before they can be deleted."}</p>
    {canManage && <Button variant="primary" type="submit" disabled={pending}>{pending ? "Saving…" : creating ? "Create Environment" : "Save changes"}</Button>}
  </>, async data => {
    const name = resourceName(String(data.get("name")));
    const body = { name, slug: creating ? slugFromName(name) || `environment-${crypto.randomUUID().slice(0, 8)}` : slug, deletionProtected: defaults || protectedEnvironment };
    const base = `${workspacePath("projects", details.project.id)}/environments`;
    if (creating) await accountRequest(base, { ...body, type: data.get("type") });
    else if (environment) await accountRequest(`${base}/${encodeURIComponent(environment.id)}/update`, body);
    await onChanged(creating ? "Environment created" : "Environment updated");
  });
}
