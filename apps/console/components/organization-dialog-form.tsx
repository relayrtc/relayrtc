"use client";

import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/checkbox";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAccount } from "./account-provider";
import { accountRequest, errorMessage } from "@/lib/account-api";
import { resourceName, workspacePath } from "@/lib/workspace-api";
import type { OrganizationDetails, OrganizationMember, PendingInvitation } from "@/lib/workspace-types";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Button } from "@/ui/button";
import { accountTime } from "@/lib/account-display";

export type OrganizationDialog = "profile" | "transfer" | "leave" | "invite" | "member" | "cancel" | "resend";
export const organizationDialogTitles: Record<OrganizationDialog, string> = { profile: "Organization profile", transfer: "Transfer ownership", leave: "Leave organization?", invite: "Invite a team member", member: "Team member", cancel: "Cancel invitation?", resend: "Resend invitation?" };

export function OrganizationDialogForm({ view, data, member, invitation, onBusy, onChanged }: {
  view: OrganizationDialog; data: OrganizationDetails; member?: OrganizationMember; invitation?: PendingInvitation;
  onBusy: (value: boolean) => void; onChanged: (message: string, left?: boolean) => Promise<void>;
}) {
  const { account } = useAccount();
  const { organization } = data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState(["owner", "admin", "developer", "viewer"].find(value => member?.role.split(",").some(item => item.trim() === value)) ?? "developer");
  const [removeMember, setRemoveMember] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const lock = useRef(false);
  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setPending(true); onBusy(true); setError("");
    try { await task(); } catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setPending(false); onBusy(false); }
  }
  function form(children: ReactNode, task: (data: FormData) => Promise<void>) {
    return <form className="account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const values = new FormData(event.currentTarget); void run(() => task(values)); }}><fieldset disabled={pending}><FormFeedback error={error} />{children}</fieldset></form>;
  }
  const action = (label: string, danger = false, disabled = false) => <Button type="submit" variant={danger ? "danger" : "primary"} disabled={pending || disabled}>{pending ? "Please wait…" : label}</Button>;

  if (view === "profile") return form(<>
    <Field label="Organization name"><input className="input" name="name" defaultValue={organization.name} maxLength={120} autoFocus required /></Field>
    <p className="account-note">The organization ID and slug stay the same.</p>{action("Save changes")}
  </>, async values => {
    await accountRequest("/api/auth/organization/update", { organizationId: organization.id, data: { name: resourceName(String(values.get("name"))) } });
    await onChanged("Organization updated");
  });

  if (view === "invite") return form(<>
    <Field label="Email Address"><input className="input" name="email" type="email" placeholder="Email Address" autoComplete="email" maxLength={320} required autoFocus /></Field>
    <Field label="Role"><Select className="input" name="role" defaultValue="developer"><option value="admin">Admin</option><option value="developer">Developer</option><option value="viewer">Viewer</option></Select></Field>
    <p className="account-note">They’ll receive an email to join {organization.name}.</p>{action("Send invitation")}
  </>, async values => {
    await accountRequest("/api/auth/organization/invite-member", { organizationId: organization.id, email: String(values.get("email")).trim().toLowerCase(), role: values.get("role") });
    await onChanged("Invitation sent");
  });

  if (view === "transfer") {
    const candidates = data.members.filter(item => item.userId !== account.user.id && !item.role.split(",").some(value => value.trim() === "owner"));
    return form(<><p className="account-note">The selected member becomes the owner. Your role changes to Viewer.</p>
      {candidates.length ? <><Field label="New owner"><Select className="input" name="targetMemberId" defaultValue="" required><option value="" disabled>Choose a member</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.name} ({item.email})</option>)}</Select></Field><label className="account-checkbox"><Checkbox type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I understand that I’ll give up ownership.</label></> : <p className="account-note">Invite another team member before transferring ownership.</p>}
      {action("Transfer ownership", true, !candidates.length || !acknowledged)}
    </>, async values => {
      if (!acknowledged) return;
      await accountRequest(`${workspacePath("organizations", organization.id)}/transfer`, { targetMemberId: values.get("targetMemberId") });
      await onChanged("Ownership transferred");
    });
  }

  if (view === "leave") return form(<><p className="account-note">You’ll lose access to {organization.name} and its projects. You’ll need a new invitation to rejoin.</p>{organization.isOwner ? <p className="account-note">Transfer ownership before leaving this organization.</p> : <label className="account-checkbox"><Checkbox type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I want to leave this organization.</label>}{action("Leave organization", true, organization.isOwner || !acknowledged)}</>, async () => {
    if (!acknowledged || organization.isOwner) return;
    await accountRequest("/api/auth/organization/leave", { organizationId: organization.id });
    await onChanged("You left the organization", true);
  });

  if (view === "cancel" || view === "resend") return form(<><p className="account-note">{view === "cancel" ? `Cancel the pending invitation for ${invitation?.email}?` : `Send a new invitation email to ${invitation?.email}?`}</p>{action(view === "cancel" ? "Cancel invitation" : "Resend invitation", view === "cancel", !invitation)}</>, async () => {
    if (!invitation) return;
    if (view === "cancel") await accountRequest("/api/auth/organization/cancel-invitation", { invitationId: invitation.id });
    else await accountRequest("/api/auth/organization/invite-member", { organizationId: organization.id, email: invitation.email, role: invitation.role ?? "developer", resend: true });
    await onChanged(view === "cancel" ? "Invitation cancelled" : "Invitation resent");
  });

  if (!member) return null;
  const isOwner = member.role.split(",").some(value => value.trim() === "owner");
  const canEdit = organization.canManage && organization.status === "active" && !isOwner;
  const canRemove = canEdit && member.userId !== account.user.id;
  if (removeMember) return form(<><p className="account-note">Remove {member.name} ({member.email}) from {organization.name}? They’ll lose access to its projects.</p>{action("Remove member", true, !canRemove)}<Button type="button" onClick={() => setRemoveMember(false)}>Back</Button></>, async () => {
    if (!canRemove) return;
    await accountRequest("/api/auth/organization/remove-member", { organizationId: organization.id, memberIdOrEmail: member.id });
    await onChanged("Team member removed");
  });
  return form(<>
    <dl className="account-detail-list"><div><dt>Name</dt><dd>{member.name}</dd></div><div><dt>Email</dt><dd>{member.email}</dd></div><div><dt>Joined</dt><dd>{accountTime(member.createdAt)}</dd></div></dl>
    <Field label="Role"><Select className="input" value={role} onChange={event => setRole(event.target.value)} disabled={!canEdit}>{isOwner && <option value="owner">Owner</option>}<option value="admin">Admin</option><option value="developer">Developer</option><option value="viewer">Viewer</option></Select></Field>
    {isOwner && <p className="account-note">Ownership changes through the transfer ownership action.</p>}
    {canEdit && action("Save role", false, role === member.role)}
    {canRemove && <Button type="button" variant="danger" onClick={() => { setRemoveMember(true); setError(""); }}>Remove member</Button>}
  </>, async () => {
    if (!canEdit) return;
    await accountRequest("/api/auth/organization/update-member-role", { organizationId: organization.id, memberId: member.id, role });
    await onChanged("Member role updated");
  });
}
