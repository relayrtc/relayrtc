"use client";

import { PanelMessage } from "@/ui/panel-message";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { useAccount } from "./account-provider";
import { useNotifications } from "./notification-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { OrganizationDialogForm, organizationDialogTitles, type OrganizationDialog } from "./organization-dialog-form";
import { ResourceDeletionDialog } from "./resource-deletion-dialog";
import { workspacePath } from "@/lib/workspace-api";
import type { OrganizationDetails } from "@/lib/workspace-types";
import { errorMessage } from "@/lib/account-api";
import { accountTime, humanizeAction } from "@/lib/account-display";
import { AccountAvatar } from "@/ui/account-avatar";
import { SettingsRow } from "@/ui/settings-row";
import { Dialog } from "@/ui/dialog";
import { Button, ButtonLink } from "@/ui/button";
import { FormFeedback } from "@/ui/auth-fields";
import { Icon } from "@/ui/icon";
import { WorkspaceState } from "@/ui/workspace-state";

export function OrganizationSettings({ id }: { id: string }) {
  const resource = useWorkspaceResource<OrganizationDetails>(workspacePath("organizations", id));
  const workspace = useWorkspace();
  const { refreshAccount } = useAccount();
  const { notify } = useNotifications();
  const router = useRouter();
  const [dialog, setDialog] = useState<OrganizationDialog | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = useCallback(() => setDialog(null), []);
  if (!resource.data) return <WorkspaceState error={resource.error} onRetry={() => void resource.refresh().catch(() => {})} title="Loading organization" />;
  const { organization, members, invitations } = resource.data;
  const canManage = organization.canManage && organization.status === "active";
  const projects = workspace.projects.filter(item => item.organizationId === id);
  async function changed(message: string, left = false) {
    notify(message); close();
    if (left) router.replace("/organizations");
    await Promise.all([workspace.refreshWorkspace(), refreshAccount()]);
  }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); notify("Copied to clipboard"); } catch (error) { setError(errorMessage(error)); } }
  async function useOrganization() {
    try { const hasProject = await workspace.switchOrganization(id); router.push(hasProject ? "/rooms" : canManage ? `/onboarding?new=project&organizationId=${encodeURIComponent(id)}` : "/projects"); }
    catch (error) { setError(errorMessage(error)); }
  }
  return <section className="content account-content" aria-label="Organization settings">
    <Link href="/organizations" className="account-back"><Icon name="chevronLeft" size={15.75} />Organizations</Link>
    <div className="profile-area"><AccountAvatar size={94.5} name={organization.name} image={organization.logo} /></div>
    <FormFeedback error={error} />
    <div className="panel"><SettingsRow icon="organization" label="Name" value={organization.name} onClick={canManage ? () => setDialog("profile") : undefined} trailing={canManage ? undefined : <></>} /><SettingsRow icon="link" label="Organization ID" value={organization.id} onClick={() => void copy(organization.id)} trailing={<Icon name="copy" size={15.75} />} /><SettingsRow icon="globe" label="Slug" value={organization.slug} onClick={() => void copy(organization.slug)} trailing={<Icon name="copy" size={15.75} />} /><SettingsRow icon="shield" label="Your role" value={humanizeAction(organization.role)} trailing={<></>} /></div>
    {organization.status === "deleting" && <p className="form-feedback workspace-notice" role="status">This organization is being deleted. Cleanup continues in the background.</p>}
    <section className="settings-section"><h2>Team</h2><div className="panel"><SettingsRow icon="users" label="Members" value={String(members.length)} href={`/organizations/${encodeURIComponent(id)}/members`} />{organization.canManage && <SettingsRow icon="email" label="Pending invitations" value={String(invitations.length)} href={`/organizations/${encodeURIComponent(id)}/members?view=invitations`} />}{organization.canManage && <SettingsRow icon="history" label="Organization activity" href={`/organizations/${encodeURIComponent(id)}/activity`} />}</div></section>
    <section className="settings-section"><div className="account-section-heading"><h2>Projects</h2></div><div className="panel">{projects.map(project => <SettingsRow key={project.id} icon="project" label={project.name} value={project.status === "active" ? undefined : humanizeAction(project.status)} href={`/projects/${encodeURIComponent(project.id)}`} />)}{!projects.length && <PanelMessage className="account-panel-message">No projects in this organization yet.</PanelMessage>}</div>{canManage && <ButtonLink icon="plus" className="workspace-section-button" href={`/onboarding?new=project&organizationId=${encodeURIComponent(id)}`}>Create Project</ButtonLink>}</section>
    <section className="settings-section"><h2>Organization</h2><div className="panel"><SettingsRow icon="calendar" label="Created" value={accountTime(organization.createdAt)} trailing={<></>} />{canManage && organization.isOwner && <SettingsRow icon="shield" label="Transfer ownership" onClick={() => setDialog("transfer")} />}{!organization.isOwner && organization.status === "active" && <SettingsRow icon="logout" label="Leave organization" className="text-danger" onClick={() => setDialog("leave")} />}{organization.isOwner && <SettingsRow icon="trash" label={organization.status === "deleting" ? "Deletion progress" : "Delete organization"} className="text-danger" onClick={() => setDialog("delete")} />}</div></section>
    {organization.status === "active" && workspace.activeOrganizationId !== id && <Button className="account-section-action" disabled={workspace.pending || workspace.loading} onClick={() => void useOrganization()}>Use this organization</Button>}
    <Dialog open={dialog !== null && dialog !== "delete"} title={dialog && dialog !== "delete" ? organizationDialogTitles[dialog] : ""} dismissible={!busy} onClose={close}>{dialog && dialog !== "delete" && <OrganizationDialogForm key={dialog} view={dialog} data={resource.data} onBusy={setBusy} onChanged={changed} />}</Dialog>
    <ResourceDeletionDialog open={dialog === "delete"} kind="organization" resource={organization} onClose={() => { close(); void workspace.refreshWorkspace().catch(() => {}); }} onComplete={() => { close(); notify("Organization deleted"); router.replace("/organizations"); void Promise.all([workspace.refreshWorkspace(), refreshAccount()]).catch(() => {}); }} />
  </section>;
}
