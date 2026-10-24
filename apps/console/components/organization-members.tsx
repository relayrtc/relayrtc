"use client";

import { AnimatedValue } from "@/ui/sliding-number";
import { PanelMessage } from "@/ui/panel-message";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useWorkspace } from "./workspace-provider";
import { useAccount } from "./account-provider";
import { useNotifications } from "./notification-provider";
import { OrganizationDialogForm, organizationDialogTitles, type OrganizationDialog } from "./organization-dialog-form";
import { workspacePath } from "@/lib/workspace-api";
import type { OrganizationDetails, OrganizationMember, PendingInvitation } from "@/lib/workspace-types";
import { accountTime, humanizeAction } from "@/lib/account-display";
import { AccountAvatar } from "@/ui/account-avatar";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icon";
import { WorkspaceState } from "@/ui/workspace-state";

export function OrganizationMembers({ id, initialView = "members" }: { id: string; initialView?: "members" | "invitations" }) {
  const resource = useWorkspaceResource<OrganizationDetails>(workspacePath("organizations", id));
  const workspace = useWorkspace(); const { refreshAccount } = useAccount(); const { notify } = useNotifications();
  const [selectedView, setView] = useState(initialView);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<OrganizationDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [member, setMember] = useState<OrganizationMember>();
  const [invitation, setInvitation] = useState<PendingInvitation>();
  const close = useCallback(() => setDialog(null), []);
  if (!resource.data) return <WorkspaceState error={resource.error} onRetry={() => void resource.refresh().catch(() => {})} title="Loading team" />;
  const { organization, members, invitations } = resource.data;
  const view = organization.canManage ? selectedView : "members";
  const canManage = organization.canManage && organization.status === "active";
  const filteredMembers = members.filter(item => `${item.name} ${item.email}`.toLowerCase().includes(query.toLowerCase()));
  const filteredInvitations = invitations.filter(item => item.email.toLowerCase().includes(query.toLowerCase()));
  async function changed(message: string) { close(); notify(message); await Promise.all([workspace.refreshWorkspace(), refreshAccount()]); }
  return <section className="content" aria-label="Organization members">
    <Link href={`/organizations/${encodeURIComponent(id)}`} className="account-back"><Icon name="chevronLeft" size={15.75} />{organization.name}</Link>
    <div className="segmented-control workspace-tabs" role="group" aria-label="Team view"><button type="button" className={view === "members" ? "segment-active" : ""} aria-pressed={view === "members"} onClick={() => setView("members")}>Members (<AnimatedValue value={members.length} />)</button>{organization.canManage && <button type="button" className={view === "invitations" ? "segment-active" : ""} aria-pressed={view === "invitations"} onClick={() => setView("invitations")}>Invitations (<AnimatedValue value={invitations.length} />)</button>}</div>
    <input className="input workspace-search" aria-label="Search team" placeholder="Search by name or email" value={query} onChange={event => setQuery(event.target.value)} />
    <section className="settings-section"><h2>{view === "members" ? "Team members" : "Pending invitations"}</h2><div className="panel">{view === "members" ? filteredMembers.map(item => <button className="account-list-row" key={item.id} onClick={() => { setMember(item); setDialog("member"); }}><AccountAvatar size={33.075} name={item.name} image={item.image} /><span className="account-list-copy"><span className="account-list-title">{item.name}</span><span className="account-list-description">{item.email}</span></span><span className="account-outcome">{humanizeAction(item.role)}</span></button>) : filteredInvitations.map(item => <div className="workspace-invitation-row" key={item.id}><div className="account-list-row"><span className="account-list-icon"><Icon name="email" size={21.2625} /></span><span className="account-list-copy"><span className="account-list-title">{item.email}</span><span className="account-list-description">{humanizeAction(item.role ?? "developer")} · Expires {accountTime(item.expiresAt)}</span></span></div>{canManage && <div className="workspace-invitation-actions"><button className="auth-text-button" onClick={() => { setInvitation(item); setDialog("resend"); }}>Resend</button><button className="auth-text-button text-danger" onClick={() => { setInvitation(item); setDialog("cancel"); }}>Cancel invitation</button></div>}</div>)}{!(view === "members" ? filteredMembers.length : filteredInvitations.length) && <PanelMessage className="account-panel-message">{query ? "No results match your search." : view === "members" ? "No members found." : "No pending invitations."}</PanelMessage>}</div></section>
    {canManage && <Button icon="plus" className="account-section-action" onClick={() => setDialog("invite")}>Invite Member</Button>}
    <Dialog open={dialog !== null} title={dialog ? organizationDialogTitles[dialog] : ""} dismissible={!busy} onClose={close}>{dialog && <OrganizationDialogForm key={`${dialog}:${member?.id ?? ""}:${invitation?.id ?? ""}`} view={dialog} data={resource.data} member={member} invitation={invitation} onBusy={setBusy} onChanged={changed} />}</Dialog>
  </section>;
}
