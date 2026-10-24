"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "./workspace-provider";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { FormFeedback } from "@/ui/auth-fields";
import { PageSkeleton } from "@/ui/skeleton";

export function WorkspaceGate({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const router = useRouter();
  useEffect(() => {
    if (!workspace.ready || workspace.pending) return;
    if (!workspace.organization) router.replace(workspace.organizations.length || workspace.invitations.length ? "/organizations" : "/onboarding");
    else if (!workspace.project) router.replace(workspace.organization.canManage ? "/onboarding?new=project" : "/projects");
  }, [workspace.ready, workspace.pending, workspace.organization, workspace.project, workspace.organizations.length, workspace.invitations.length, router]);
  if ((!workspace.ready || workspace.pending || !workspace.organization || !workspace.project) && !workspace.error) return <PageSkeleton />;
  if (workspace.error) return <section className="content"><div className="empty-state"><div className="empty-state-icon"><Icon name="organization" size={32} /></div><h2>Workspace unavailable</h2><FormFeedback error={workspace.error} /><Button onClick={() => void workspace.refreshWorkspace().catch(() => {})}>Try again</Button></div></section>;
  return children;
}
