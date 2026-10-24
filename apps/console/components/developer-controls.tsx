"use client";

import Link from "next/link";
import { useWorkspace } from "./workspace-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import type { DeveloperProject } from "@/lib/developer-types";
import { developerPath, projectHref } from "@/lib/developer-api";
import { Icon } from "@/ui/icon";
import { SettingsRow } from "@/ui/settings-row";
import { WorkspaceState } from "@/ui/workspace-state";

export function ActiveDeveloperControls() {
  const { project } = useWorkspace();
  return project ? <DeveloperControls key={project.id} projectId={project.id} /> : null;
}

export function DeveloperControls({ projectId }: { projectId: string }) {
  const resource = useWorkspaceResource<DeveloperProject>(developerPath(projectId));
  if (!resource.data) return <WorkspaceState error={resource.error} title="Loading developer controls" onRetry={() => void resource.refresh().catch(() => {})} />;
  const { project, environments, canManage } = resource.data;
  const href = projectHref(project.id);
  return <section className="content account-content" aria-label="Developer controls"><Link className="account-back" href={href}><Icon name="chevronLeft" size={15.75} />Project settings</Link><div className="panel"><SettingsRow icon="project" label="Project" value={project.name} href={href} /><SettingsRow icon="globe" label="Environments" value={String(environments.filter(item => item.status === "active").length)} href={`${href}#environments`} /></div><section className="settings-section"><h2>Developer Controls</h2><div className="panel"><SettingsRow icon="secretKeys" label="API keys" href={`${href}/api-keys`} /><SettingsRow icon="link" label="Webhooks" href={`${href}/webhooks`} /></div><p className="account-section-note">{canManage ? "Manage credentials, event subscriptions, and webhook delivery for this project." : "View project credentials and webhook delivery. Owners and admins can make changes."}</p></section><section className="settings-section"><h2>Integration</h2><div className="panel"><SettingsRow icon="signaling" label="SDK and API documentation" href="https://docs.relayrtc.com" /></div><p className="account-section-note">API keys belong to a single environment. Keep secret keys and webhook signing secrets on your server.</p></section></section>;
}
