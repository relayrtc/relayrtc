"use client";

import { PanelMessage } from "@/ui/panel-message";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useWorkspace } from "./workspace-provider";
import { useNotifications } from "./notification-provider";
import { ProjectDialogForm, type ProjectDialog } from "./project-dialog-form";
import { ResourceDeletionDialog } from "./resource-deletion-dialog";
import { workspacePath } from "@/lib/workspace-api";
import type { ProjectDetails, ProjectEnvironment } from "@/lib/workspace-types";
import { accountTime, humanizeAction } from "@/lib/account-display";
import { errorMessage } from "@/lib/account-api";
import { SettingsRow } from "@/ui/settings-row";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { WorkspaceState } from "@/ui/workspace-state";

export function ProjectSettings({ id }: { id: string }) {
  const resource = useWorkspaceResource<ProjectDetails>(workspacePath("projects", id));
  const workspace = useWorkspace(); const { notify } = useNotifications(); const router = useRouter();
  const [dialog, setDialog] = useState<ProjectDialog | null>(null);
  const [environment, setEnvironment] = useState<ProjectEnvironment>();
  const [deleteTarget, setDeleteTarget] = useState<ProjectEnvironment | "project" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = useCallback(() => setDialog(null), []);
  if (!resource.data) return <WorkspaceState error={resource.error} onRetry={() => void resource.refresh().catch(() => {})} title="Loading project" />;
  const { project, environments } = resource.data;
  const canManage = resource.data.canManage && project.status !== "deleting" && project.status !== "deleted";
  const organization = workspace.organizations.find(item => item.id === project.organizationId);
  async function changed(message: string) { close(); notify(message); await workspace.refreshWorkspace(); }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); notify("Copied to clipboard"); } catch (error) { setError(errorMessage(error)); } }
  async function useProject() { try { await workspace.switchProject(id); router.push("/rooms"); } catch (error) { setError(errorMessage(error)); } }
  return <section className="content account-content" aria-label="Project settings">
    <Link href="/projects" className="account-back"><Icon name="chevronLeft" size={15.75} />Projects</Link>
    <div className="panel"><SettingsRow icon="project" label="Name" value={project.name} onClick={canManage ? () => setDialog("rename") : undefined} trailing={canManage ? undefined : <></>} /><SettingsRow icon="organization" label="Organization" value={organization?.name ?? "Organization settings"} href={`/organizations/${encodeURIComponent(project.organizationId)}`} /><SettingsRow icon="link" label="Project ID" value={project.id} onClick={() => void copy(project.id)} trailing={<Icon name="copy" size={15.75} />} /><SettingsRow icon="globe" label="Slug" value={project.slug} onClick={() => void copy(project.slug)} trailing={<Icon name="copy" size={15.75} />} /><SettingsRow icon="info" label="Status" value={humanizeAction(project.status)} trailing={<></>} /></div>
    <FormFeedback error={error} />
    <section className="settings-section" id="environments"><h2>Environments</h2><div className="panel">{environments.map(item => <div className="workspace-environment-row" key={item.id}><button className="account-list-row" onClick={() => { setEnvironment(item); setDialog("environment"); }}><span className="account-list-icon"><Icon name="project" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{item.name}</span><span className="account-list-description">{item.slug} · {humanizeAction(item.type)}{item.status === "deleting" ? " · Deleting" : ""}</span></span>{item.deletionProtected && <Icon name="password" size={15.75} className="muted" />}</button>{resource.data?.canManage && (item.status === "deleting" || (canManage && !item.deletionProtected && !["development", "production"].includes(item.type))) && <button className="icon-button workspace-environment-delete" aria-label={item.status === "deleting" ? `View deletion of ${item.name}` : `Delete ${item.name}`} onClick={() => setDeleteTarget(item)}><Icon name={item.status === "deleting" ? "history" : "trash"} size={15.75} /></button>}</div>)}{!environments.length && <PanelMessage className="account-panel-message">No environments found.</PanelMessage>}</div>
      <p className="account-section-note">Development and Production are created with every project and cannot be deleted.</p>{canManage && <Button className="workspace-section-button" icon="plus" onClick={() => { setEnvironment(undefined); setDialog("create-environment"); }}>Create Environment</Button>}
    </section>
    <section className="settings-section"><h2>Developer Controls</h2><div className="panel"><SettingsRow icon="secretKeys" label="API keys" href={`/projects/${encodeURIComponent(id)}/api-keys`} /><SettingsRow icon="link" label="Webhooks" href={`/projects/${encodeURIComponent(id)}/webhooks`} /></div></section>
    <section className="settings-section"><h2>Project</h2><div className="panel"><SettingsRow icon="calendar" label="Created" value={accountTime(project.createdAt)} trailing={<></>} />{resource.data.canManage && <SettingsRow icon="trash" className="text-danger" label={project.status === "deleting" ? "Deletion progress" : "Delete project"} onClick={() => setDeleteTarget("project")} />}</div></section>
    {project.status === "active" && workspace.activeProjectId !== id && <Button className="account-section-action" disabled={workspace.pending || workspace.loading} onClick={() => void useProject()}>Use this project</Button>}
    <Dialog open={dialog !== null} title={dialog === "rename" ? "Project name" : dialog === "create-environment" ? "Create Environment" : "Environment settings"} dismissible={!busy} onClose={close}>{dialog && <ProjectDialogForm key={`${dialog}:${environment?.id ?? ""}`} view={dialog} details={resource.data} environment={environment} onBusy={setBusy} onChanged={changed} />}</Dialog>
    <ResourceDeletionDialog open={deleteTarget !== null} kind={deleteTarget === "project" ? "project" : "environment"} resource={deleteTarget && deleteTarget !== "project" ? deleteTarget : project} projectId={id} onClose={() => { setDeleteTarget(null); void workspace.refreshWorkspace().catch(() => {}); }} onComplete={() => { const deletingProject = deleteTarget === "project"; setDeleteTarget(null); notify(deletingProject ? "Project deleted" : "Environment deleted"); if (deletingProject) router.replace("/projects"); void workspace.refreshWorkspace().catch(() => {}); }} />
  </section>;
}
