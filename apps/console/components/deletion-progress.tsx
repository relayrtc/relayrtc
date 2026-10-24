"use client";

import type { DeletionKind, DeletionResult } from "@/lib/workspace-types";
import { workspaceApi } from "@/lib/workspace-api";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { WorkspaceState } from "@/ui/workspace-state";
import { SettingsRow } from "@/ui/settings-row";
import { ButtonLink } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { FormFeedback } from "@/ui/auth-fields";

export function DeletionProgress({ kind, resourceId }: { kind: DeletionKind; resourceId: string }) {
  const resource = useWorkspaceResource<DeletionResult>(`${workspaceApi}/deletions?${new URLSearchParams({ kind, resourceId })}`);
  const operation = resource.data?.operation;
  useRealtimeRefresh(resource.refresh, Boolean(operation && operation.status !== "completed") && !resource.error, 3000);
  if (!resource.data) return <WorkspaceState title="Loading deletion progress" error={resource.error} onRetry={() => void resource.refresh().catch(() => {})} />;
  return <section className="content account-content" aria-label="Deletion progress"><FormFeedback error={resource.error} />{operation ? <>
    <h2>{kind[0].toUpperCase() + kind.slice(1)} deletion</h2>
    <p className="account-note" role="status">{operation.status === "completed" ? "Deletion completed." : operation.status === "failed" ? "Cleanup will retry automatically. You can leave this page." : "Your resources are being disconnected and cleaned up. Cleanup continues when you leave this page."}</p>
    <div className="panel"><SettingsRow icon="history" label="Status" value={operation.status} trailing={<></>} /><SettingsRow icon="history" label="Attempts" value={String(operation.attempts)} trailing={<></>} /></div>
  </> : <EmptyState icon="history" title="No deletion in progress" description="There is no visible deletion operation for this resource." />}<ButtonLink href="/organizations" className="account-section-action">Your organizations</ButtonLink></section>;
}
