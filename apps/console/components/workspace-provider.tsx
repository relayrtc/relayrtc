"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { accountRequest, AccountApiError, errorMessage } from "@/lib/account-api";
import { emptySelection, readSelection, resourceName, selectWorkspace, selectionStorageKey, setActiveOrganization, workspaceApi } from "@/lib/workspace-api";
import type { Organization, Project, WorkspaceSelection, WorkspaceSnapshot } from "@/lib/workspace-types";
import { useAccount } from "./account-provider";

type WorkspaceContext = WorkspaceSnapshot & {
  ready: boolean; loading: boolean; pending: boolean; error: string; revision: number;
  organization: Organization | undefined; project: Project | undefined;
  activeProjectId: string | null;
  refreshWorkspace: (preferred?: { organizationId?: string; projectId?: string | null }) => Promise<WorkspaceSnapshot>;
  createOrganization: (name: string) => Promise<Organization>;
  createProject: (name: string, organizationId?: string) => Promise<Project>;
  switchOrganization: (id: string) => Promise<boolean>; switchProject: (id: string) => Promise<void>;
};
const Context = createContext<WorkspaceContext | null>(null);
const empty: WorkspaceSnapshot = { userId: "", organizations: [], projects: [], invitations: [], activeOrganizationId: null };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { account, expireSession, refreshAccount } = useAccount();
  const key = selectionStorageKey(account.user.id);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(empty);
  const [selection, setSelection] = useState<WorkspaceSelection>(emptySelection);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const selectionRef = useRef<WorkspaceSelection>(emptySelection);
  const sequence = useRef(0);
  const lock = useRef(false);
  const commit = useCallback((next: WorkspaceSelection) => {
    selectionRef.current = next; setSelection(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Selection works for this visit without storage. */ }
  }, [key]);

  const refreshWorkspace = useCallback(async (preferred?: { organizationId?: string; projectId?: string | null }) => {
    const request = ++sequence.current; setLoading(true); setError("");
    try {
      const data = await accountRequest<WorkspaceSnapshot>(workspaceApi);
      if (typeof data.userId !== "string") throw new AccountApiError("Workspace services returned an unexpected response. Please try again.", 503);
      if (data.userId !== account.user.id) {
        window.location.reload();
        throw new AccountApiError("Your session changed. Reloading your workspace…", 409);
      }
      if (request === sequence.current) {
        const next = selectWorkspace(data, selectionRef.current, preferred);
        setSnapshot(data); commit(next); setInitialized(true); setRevision(value => value + 1);
      }
      return data;
    } catch (error) {
      if (request === sequence.current) {
        setInitialized(false); setError(errorMessage(error));
        if (error instanceof AccountApiError && error.status === 401) expireSession();
      }
      throw error;
    } finally { if (request === sequence.current) setLoading(false); }
  }, [commit, expireSession, account.user.id]);

  useEffect(() => {
    selectionRef.current = readSelection(key);
    void refreshWorkspace().catch(() => {});
    let lastRefresh = Date.now();
    const refresh = () => {
      if (lock.current || document.visibilityState !== "visible" || Date.now() - lastRefresh < 30000) return;
      lastRefresh = Date.now(); void refreshWorkspace().catch(() => {});
    };
    const storage = (event: StorageEvent) => { if (event.key === key && !lock.current) { selectionRef.current = readSelection(key); void refreshWorkspace().catch(() => {}); } };
    window.addEventListener("focus", refresh); window.addEventListener("storage", storage); document.addEventListener("visibilitychange", refresh);
    return () => { sequence.current++; window.removeEventListener("focus", refresh); window.removeEventListener("storage", storage); document.removeEventListener("visibilitychange", refresh); };
  }, [key, refreshWorkspace]);

  const mutate = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    if (lock.current) throw new Error("Please wait for the current workspace change.");
    lock.current = true; setPending(true);
    try { return await task(); }
    catch (error) { if (error instanceof AccountApiError && error.status === 401) expireSession(); throw error; }
    finally { lock.current = false; setPending(false); }
  }, [expireSession]);

  const createOrganization = useCallback((name: string) => mutate(async () => {
    const created = await accountRequest<{ id: string }>("/api/auth/organization/create", { name: resourceName(name) });
    await setActiveOrganization(created.id);
    const data = await refreshWorkspace({ organizationId: created.id, projectId: null });
    await refreshAccount();
    const organization = data.organizations.find(item => item.id === created.id);
    if (!organization) throw new Error("Organization created. Refresh your workspace to continue.");
    return organization;
  }), [mutate, refreshWorkspace, refreshAccount]);
  const createProject = useCallback((name: string, organizationId?: string) => mutate(async () => {
    const id = organizationId ?? selectionRef.current.organizationId;
    if (!id) throw new Error("Choose an organization first.");
    const created = await accountRequest<Project>(`${workspaceApi}/projects`, { name: resourceName(name), organizationId: id });
    if (id !== selectionRef.current.organizationId) await setActiveOrganization(id);
    await refreshWorkspace({ organizationId: id, projectId: created.id });
    return created;
  }), [mutate, refreshWorkspace]);
  const switchOrganization = useCallback((id: string) => mutate(async () => {
    const available = await accountRequest<WorkspaceSnapshot>(workspaceApi);
    if (!available.organizations.some(item => item.id === id && item.status === "active")) throw new Error("Choose an available organization.");
    await setActiveOrganization(id);
    const data = await refreshWorkspace({ organizationId: id });
    return data.projects.some(item => item.organizationId === id && item.status === "active");
  }), [mutate, refreshWorkspace]);
  const switchProject = useCallback((id: string) => mutate(async () => {
    // Re-read access before selecting a saved or previously listed project.
    const data = await accountRequest<WorkspaceSnapshot>(workspaceApi);
    const project = data.projects.find(item => item.id === id && item.status === "active");
    if (!project || !data.organizations.some(item => item.id === project.organizationId && item.status === "active")) throw new Error("This project is unavailable or you no longer have access.");
    if (project.organizationId !== selectionRef.current.organizationId) await setActiveOrganization(project.organizationId);
    await refreshWorkspace({ organizationId: project.organizationId, projectId: id });
  }), [mutate, refreshWorkspace]);

  const ready = initialized && !error;
  const organization = ready ? snapshot.organizations.find(item => item.id === selection.organizationId && item.status === "active") : undefined;
  const project = ready ? snapshot.projects.find(item => item.id === selection.projectId && item.organizationId === organization?.id && item.status === "active") : undefined;
  const value = useMemo(() => ({ ...snapshot, activeOrganizationId: organization?.id ?? null, activeProjectId: project?.id ?? null,
    ready, loading, pending, error, revision, organization, project,
    refreshWorkspace, createOrganization, createProject, switchOrganization, switchProject,
  }), [snapshot, organization, project, ready, loading, pending, error, revision, refreshWorkspace, createOrganization, createProject, switchOrganization, switchProject]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return value;
}
