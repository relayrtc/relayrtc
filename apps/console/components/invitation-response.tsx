"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useWorkspace } from "./workspace-provider";
import { useAccount } from "./account-provider";
import { useNotifications } from "./notification-provider";
import { accountRequest, errorMessage } from "@/lib/account-api";
import { workspaceApi } from "@/lib/workspace-api";
import type { WorkspaceInvitation } from "@/lib/workspace-types";
import { AuthFrame } from "@/ui/auth-frame";
import { Button } from "@/ui/button";
import { FormFeedback } from "@/ui/auth-fields";
import { humanizeAction } from "@/lib/account-display";

export function InvitationResponse({ id }: { id: string }) {
  const resource = useWorkspaceResource<WorkspaceInvitation>(`${workspaceApi}/invitations/${encodeURIComponent(id)}`);
  const workspace = useWorkspace(); const { signOut } = useAccount(); const { notify } = useNotifications(); const router = useRouter();
  const [pending, setPending] = useState<"accept" | "reject" | "logout" | null>(null);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function respond(action: "accept" | "reject") {
    if (!resource.data || lock.current) return;
    lock.current = true; setPending(action); setError("");
    try {
      await accountRequest(`/api/auth/organization/${action === "accept" ? "accept-invitation" : "reject-invitation"}`, { invitationId: id });
      if (action === "accept") await workspace.switchOrganization(resource.data.organizationId);
      else await workspace.refreshWorkspace();
      notify(action === "accept" ? "Invitation accepted" : "Invitation declined"); router.replace(action === "accept" ? "/projects" : "/organizations");
    } catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setPending(null); }
  }
  async function switchAccount() {
    if (lock.current) return; lock.current = true; setPending("logout");
    try { await signOut(`/invitations/${encodeURIComponent(id)}`); }
    catch (error) { setError(errorMessage(error)); lock.current = false; setPending(null); }
  }
  return <AuthFrame title={resource.data ? `Join ${resource.data.organizationName}` : resource.error ? "Invitation unavailable" : "Loading invitation"} description={resource.data ? `${resource.data.inviterName} invited you to collaborate.` : "Review an invitation to your Relayrtc workspace."}>
    <div className="login-form auth-form"><FormFeedback error={error || resource.error} />{resource.data && <><p className="auth-hint">Invited as {humanizeAction(resource.data.role ?? "developer")} · {resource.data.email}</p><Button className="onboarding-continue" variant="primary" disabled={pending !== null} onClick={() => void respond("accept")}>{pending === "accept" ? "Joining…" : "Accept invitation"}</Button><Button className="onboarding-continue" disabled={pending !== null} onClick={() => void respond("reject")}>{pending === "reject" ? "Declining…" : "Decline"}</Button></>}{resource.loading && !resource.data && <p className="auth-hint" role="status">Please wait a moment…</p>}{resource.error && <button className="auth-text-button" onClick={() => void resource.refresh().catch(() => {})}>Try again</button>}<button className="auth-text-button" onClick={() => void switchAccount()} disabled={pending !== null}>{pending === "logout" ? "Logging out…" : "Use a different account"}</button><Link className="auth-text-button" href="/organizations">Your organizations</Link></div>
  </AuthFrame>;
}
