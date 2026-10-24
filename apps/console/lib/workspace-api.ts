import { accountRequest } from "./account-api";
import type { WorkspaceSelection, WorkspaceSnapshot } from "./workspace-types";

export const workspaceApi = "/api/account/workspaces";
export const workspacePath = (kind: "organizations" | "projects", id: string) => `${workspaceApi}/${kind}/${encodeURIComponent(id)}`;
export const selectionStorageKey = (userId: string) => `relayrtc-workspace-selection:${encodeURIComponent(userId)}`;
export const emptySelection: WorkspaceSelection = { organizationId: null, projectId: null, lastProjectIds: {} };

export function readSelection(key: string): WorkspaceSelection {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!data || typeof data !== "object") return emptySelection;
    const ids: Record<string, string> = {};
    if (data.lastProjectIds && typeof data.lastProjectIds === "object") for (const [org, project] of Object.entries(data.lastProjectIds)) {
      if (typeof project === "string" && project.length <= 128) ids[org] = project;
    }
    return { organizationId: typeof data.organizationId === "string" ? data.organizationId : null, projectId: typeof data.projectId === "string" ? data.projectId : null, lastProjectIds: ids };
  } catch { return emptySelection; }
}

// Saved IDs are preferences only. Every selection must still be present in
// the authenticated API response, with an active parent and active project.
export function selectWorkspace(snapshot: WorkspaceSnapshot, saved: WorkspaceSelection, preferred?: { organizationId?: string; projectId?: string | null }): WorkspaceSelection {
  const organizations = snapshot.organizations.filter(item => item.status === "active");
  const organization = organizations.find(item => item.id === preferred?.organizationId)
    ?? organizations.find(item => item.id === snapshot.activeOrganizationId)
    ?? organizations.find(item => item.id === saved.organizationId) ?? organizations[0];
  const projects = snapshot.projects.filter(item => item.organizationId === organization?.id && item.status === "active");
  const id = preferred?.projectId !== undefined ? preferred.projectId : saved.lastProjectIds[organization?.id ?? ""];
  const project = projects.find(item => item.id === id) ?? projects[0];
  const lastProjectIds: Record<string, string> = {};
  for (const org of organizations) {
    const previous = saved.lastProjectIds[org.id];
    if (snapshot.projects.some(item => item.id === previous && item.organizationId === org.id && item.status === "active")) lastProjectIds[org.id] = previous;
  }
  if (organization && project) lastProjectIds[organization.id] = project.id;
  return { organizationId: organization?.id ?? null, projectId: project?.id ?? null, lastProjectIds };
}

export function resourceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new Error("Use a name with 1 to 120 characters.");
  return trimmed;
}

export async function setActiveOrganization(organizationId: string) {
  await accountRequest("/api/auth/organization/set-active", { organizationId });
}
