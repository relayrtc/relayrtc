"use client";

import { PanelMessage } from "@/ui/panel-message";

import Link from "next/link";
import { useWorkspace } from "./workspace-provider";
import { Icon } from "@/ui/icon";
import { ButtonLink } from "@/ui/button";
import { SettingsRow } from "@/ui/settings-row";
import { WorkspaceState } from "@/ui/workspace-state";
import { humanizeAction } from "@/lib/account-display";

export function OrganizationsList() {
  const workspace = useWorkspace();
  if (!workspace.ready) return <WorkspaceState error={workspace.error} onRetry={() => void workspace.refreshWorkspace().catch(() => {})} />;
  return <section className="content" aria-label="Organizations">
    <div className="panel"><SettingsRow icon="organization" label="Your organizations" value={String(workspace.organizations.length)} trailing={<></>} /></div>
    <section className="settings-section"><h2>Organizations</h2><div className="panel">{workspace.organizations.map(organization => <Link className="account-list-row" key={organization.id} href={`/organizations/${encodeURIComponent(organization.id)}`}><span className="account-list-icon"><Icon name="organization" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{organization.name}</span><span className="account-list-description">{humanizeAction(organization.role)} · {workspace.projects.filter(item => item.organizationId === organization.id && item.status === "active").length} projects</span></span>{organization.status === "deleting" ? <span className="account-outcome">Deleting</span> : <Icon name="chevronRight" className="row-chevron" size={17.325} />}</Link>)}{!workspace.organizations.length && <PanelMessage className="account-panel-message">Create an organization or accept an invitation to get started.</PanelMessage>}</div></section>
    <ButtonLink href="/onboarding?new=organization" icon="plus" className="account-section-action">Create Organization</ButtonLink>
    {!!workspace.invitations.length && <section className="settings-section"><h2>Your invitations</h2><div className="panel">{workspace.invitations.map(invitation => <Link href={`/invitations/${encodeURIComponent(invitation.id)}`} key={invitation.id} className="account-list-row"><span className="account-list-icon"><Icon name="email" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{invitation.organizationName}</span><span className="account-list-description">Invited as {invitation.role ?? "developer"}</span></span><Icon name="chevronRight" className="row-chevron" size={17.325} /></Link>)}</div></section>}
  </section>;
}

export function ProjectsList() {
  const workspace = useWorkspace();
  if (!workspace.ready) return <WorkspaceState error={workspace.error} onRetry={() => void workspace.refreshWorkspace().catch(() => {})} />;
  const projects = workspace.projects.filter(project => project.organizationId === workspace.organization?.id);
  return <section className="content" aria-label="Projects">
    <div className="panel"><SettingsRow icon="organization" label="Organization" value={workspace.organization?.name ?? "Choose organization"} href={workspace.organization ? `/organizations/${encodeURIComponent(workspace.organization.id)}` : "/organizations"} /><SettingsRow icon="project" label="Projects" value={String(projects.length)} trailing={<></>} /></div>
    <section className="settings-section"><h2>Your projects</h2><div className="panel">{projects.map(project => <Link key={project.id} href={`/projects/${encodeURIComponent(project.id)}`} className="account-list-row"><span className="account-list-icon"><Icon name="project" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{project.name}</span><span className="account-list-description">{project.slug}</span></span>{project.status !== "active" ? <span className="account-outcome">{humanizeAction(project.status)}</span> : <Icon name="chevronRight" className="row-chevron" size={17.325} />}</Link>)}{!projects.length && <PanelMessage className="account-panel-message">{workspace.organization?.canManage ? "Create the first project in your organization." : workspace.organization ? "An organization owner or admin can create a project for your team." : "Choose an organization to see its projects."}</PanelMessage>}</div></section>
    {workspace.organization?.canManage && <ButtonLink href="/onboarding?new=project" icon="plus" className="account-section-action">Create Project</ButtonLink>}
    {!workspace.organization && <ButtonLink href="/organizations" className="account-section-action">Choose Organization</ButtonLink>}
  </section>;
}
