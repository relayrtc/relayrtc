"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { useNotifications } from "./notification-provider";
import { errorMessage } from "@/lib/account-api";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icon";
import { SettingsRow } from "@/ui/settings-row";
import { FormFeedback } from "@/ui/auth-fields";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";

export function WorkspaceSwitcher({ mobile = false }: { mobile?: boolean }) {
  const workspace = useWorkspace();
  const { notify } = useNotifications();
  const router = useRouter();
  const pathname = usePathname();
  const [mode, setMode] = useState<"workspace" | "organization" | "project" | null>(null);
  const [error, setError] = useState("");
  const projects = workspace.projects.filter(project => project.organizationId === workspace.activeOrganizationId && project.status === "active");
  function open(next: "workspace" | "organization" | "project") { setError(""); setMode(next); }
  function returnToList(organizationId?: string, projectId?: string) {
    setMode(null);
    if (pathname.startsWith("/rooms/")) router.push("/rooms");
    else if (pathname.startsWith("/streams/")) router.push("/streams");
    else if (pathname.startsWith("/organizations/") && organizationId) router.push(`/organizations/${encodeURIComponent(organizationId)}`);
    else if (pathname.startsWith("/projects/")) router.push(projectId ? `/projects/${encodeURIComponent(projectId)}` : "/projects");
  }
  async function chooseOrganization(id: string) {
    setError("");
    try {
      const hasProject = await workspace.switchOrganization(id);
      notify("Organization switched"); returnToList(id);
      if (!hasProject) router.push(workspace.organizations.find(item => item.id === id)?.canManage ? `/onboarding?new=project&organizationId=${encodeURIComponent(id)}` : "/projects");
    } catch (error) { setError(errorMessage(error)); }
  }
  async function chooseProject(id: string) {
    setError("");
    try { await workspace.switchProject(id); notify("Project switched"); returnToList(undefined, id); }
    catch (error) { setError(errorMessage(error)); }
  }
  const openOrganization = () => open(workspace.error ? "workspace" : "organization");
  const openProject = () => open(workspace.error ? "workspace" : "project");
  const disabled = workspace.loading || workspace.pending;
  return <>
    {mobile ? <button type="button" className="icon-button mobile-workspace-button" aria-label="Switch organization and project" onClick={() => open("workspace")} disabled={disabled}><Icon name="organization" size={20.475} /></button> : <div className="workspace-switchers" aria-label="Workspace selection">
      <button type="button" className="workspace-switch-button" aria-label="Switch organization" disabled={disabled} onClick={openOrganization} title={workspace.organization?.name}><Icon name="organization" /><span className="workspace-switch-copy"><small>Organization</small><span>{workspace.loading && !workspace.ready ? <Skeleton className="skeleton-selection" /> : workspace.error ? "Unavailable" : workspace.organization?.name ?? "Create organization"}</span></span><Icon name="chevronDown" size={14.175} /></button>
      <button type="button" className="workspace-switch-button" aria-label="Switch project" disabled={disabled || (!workspace.organization && !workspace.error)} onClick={openProject} title={workspace.project?.name}><Icon name="project" /><span className="workspace-switch-copy"><small>Project</small><span>{workspace.loading && !workspace.ready ? <Skeleton className="skeleton-selection" /> : workspace.error ? "Unavailable" : workspace.project?.name ?? (workspace.organization?.canManage ? "Create project" : "No projects")}</span></span><Icon name="chevronDown" size={14.175} /></button>
    </div>}
    <Dialog open={mode !== null} title={mode === "organization" ? "Switch organization" : mode === "project" ? "Switch project" : "Your workspace"} description={mode === "project" ? workspace.organization?.name : undefined} dismissible={!workspace.pending} onClose={() => setMode(null)}>
      <div className="form-stack"><FormFeedback error={error || workspace.error} />
        {workspace.error ? <Button onClick={() => void workspace.refreshWorkspace().catch(() => {})} disabled={workspace.loading}>Try again</Button> : mode === "workspace" ? <div className="panel"><SettingsRow icon="organization" label="Organization" value={workspace.organization?.name ?? "Choose"} onClick={openOrganization} /><SettingsRow icon="project" label="Project" value={workspace.project?.name ?? "Choose"} onClick={workspace.organization ? openProject : openOrganization} /><SettingsRow icon="organization" label="Manage organizations" href="/organizations" /><SettingsRow icon="project" label="Manage projects" href="/projects" /></div> : <>
          <div className="workspace-choice-list" role="group" aria-label={mode === "organization" ? "Organizations" : "Projects"}>
            {mode === "organization" ? workspace.organizations.filter(item => item.status === "active").map(organization => <button key={organization.id} type="button" className="workspace-choice" disabled={disabled} aria-pressed={organization.id === workspace.activeOrganizationId} onClick={() => void chooseOrganization(organization.id)}><Icon name="organization" size={18.1125} /><span>{organization.name}</span>{organization.id === workspace.activeOrganizationId && <Icon name="check" size={15.75} />}</button>) : projects.map(project => <button key={project.id} type="button" className="workspace-choice" disabled={disabled} aria-pressed={project.id === workspace.activeProjectId} onClick={() => void chooseProject(project.id)}><Icon name="project" size={18.1125} /><span>{project.name}</span>{project.id === workspace.activeProjectId && <Icon name="check" size={15.75} />}</button>)}
            {mode === "organization" && !workspace.organizations.some(item => item.status === "active") && <p className="account-note">Create an organization or accept an invitation to get started.</p>}
            {mode === "project" && !projects.length && <p className="account-note">{workspace.organization?.canManage ? "Create the first project in this organization." : "An owner or admin can create projects for your team."}</p>}
          </div>
          {!workspace.pending && <><div className="panel"><SettingsRow icon={mode === "organization" ? "organization" : "project"} label={mode === "organization" ? "Manage organizations" : "Project settings"} href={mode === "organization" ? "/organizations" : workspace.project ? `/projects/${encodeURIComponent(workspace.project.id)}` : "/projects"} /></div>
            {(mode === "organization" || workspace.organization?.canManage) && <Link className="button button-secondary" href={mode === "organization" ? "/onboarding?new=organization" : "/onboarding?new=project"} onClick={() => setMode(null)}><Icon name="plus" size={17.325} />{mode === "organization" ? "Create Organization" : "Create Project"}</Link>}
            {mode === "project" && workspace.organization && <Link className="auth-text-button" href={`/organizations/${encodeURIComponent(workspace.organization.id)}`}>Organization settings</Link>}
          </>}
        </>}
      </div>
    </Dialog>
  </>;
}
