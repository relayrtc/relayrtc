"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/account-api";
import type { LegacyConsoleDestination } from "@/lib/legacy-console";
import { WorkspaceState } from "@/ui/workspace-state";
import { useWorkspace } from "./workspace-provider";
import { useRooms } from "./rooms-provider";

export function LegacyConsoleRedirect({ destination }: { destination: LegacyConsoleDestination }) {
  const workspace = useWorkspace(), rooms = useRooms(), router = useRouter();
  const [selected, setSelected] = useState(false), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const started = useRef(false), redirected = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!workspace.ready || workspace.loading || workspace.pending || started.current) return;
    started.current = true;
    void (async () => {
      const organization = workspace.organizations.find(item => item.id === destination.organizationId);
      if (!organization) throw new Error("This organization is unavailable or you no longer have access.");
      if (organization.status === "deleting") { router.replace(`/cleanup/organization/${encodeURIComponent(organization.id)}`); return; }
      if (destination.projectId) {
        const project = workspace.projects.find(item => item.id === destination.projectId && item.organizationId === organization.id);
        if (!project) throw new Error("This project is unavailable or you no longer have access.");
        if (project.status === "deleting") { router.replace(`/cleanup/project/${encodeURIComponent(project.id)}`); return; }
        if (workspace.activeProjectId !== project.id) await workspace.switchProject(project.id);
      } else if (workspace.activeOrganizationId !== organization.id) await workspace.switchOrganization(organization.id);
      if (mounted.current) setSelected(true);
    })().catch(error => { if (mounted.current) setError(errorMessage(error)); });
  }, [workspace, destination, router, attempt]);

  useEffect(() => {
    if (!selected || redirected.current) return;
    const environmentId = new URL(destination.href, "https://console.invalid").searchParams.get("environmentId");
    if (destination.projectId && environmentId) {
      if (rooms.projectId !== destination.projectId || !rooms.ready) return;
      if (!rooms.environments.some(item => item.id === environmentId)) { setError("This environment is unavailable in the selected project."); return; }
      if (rooms.environmentId !== environmentId) rooms.setEnvironmentId(environmentId);
    }
    redirected.current = true;
    router.replace(destination.href);
  }, [selected, destination, rooms, router]);

  return <WorkspaceState title="Opening workspace" error={error || workspace.error || (selected ? rooms.error : "")} onRetry={() => {
    started.current = false; redirected.current = false; setSelected(false); setError("");
    void workspace.refreshWorkspace().then(() => rooms.refresh()).catch(() => {});
    setAttempt(value => value + 1);
  }} />;
}
