"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  BookOpen,
  Download,
  Eye,
  FileText,
  Globe,
  KeyRound,
  LoaderCircle,
  Search,
  Settings,
  Trash2,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  authError,
  toOrganizationInvitationError,
  toOrganizationMemberError,
  type AuthError,
} from "@relayrtc/auth";
import {
  inviteOrganizationMemberInputSchema,
  removeOrganizationMemberInputSchema,
  updateOrganizationMemberRoleInputSchema,
} from "@relayrtc/validation";
import { AuthErrorMessage } from "@/components/auth/auth-error-message";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type Role = "owner" | "admin" | "developer" | "viewer";

type InviteRole = "admin" | "developer" | "viewer";

type View = "members" | "invitations";

type PermissionKey =
  "api-keys" | "environments" | "domains" | "audit" | "observability" | "members" | "settings";

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

interface TeamMembersProps {
  organizationId: string;
  currentUserId: string;
  currentRole: string;
  members: readonly Member[];
  invitations: readonly Invitation[];
}

const permissionIcons: Record<PermissionKey, LucideIcon> = {
  "api-keys": KeyRound,
  environments: BookOpen,
  domains: Globe,
  audit: FileText,
  observability: Eye,
  members: Users,
  settings: Settings,
};

const permissionLabels: Record<PermissionKey, string> = {
  "api-keys": "API keys",
  environments: "Environments",
  domains: "Domains",
  audit: "Audit log",
  observability: "Observability",
  members: "Members",
  settings: "Settings",
};

const permissionOrder: PermissionKey[] = [
  "api-keys",
  "environments",
  "domains",
  "audit",
  "observability",
  "members",
  "settings",
];

const roleMeta: Record<
  Role,
  {
    label: string;
    description: string;
    permissions: PermissionKey[];
  }
> = {
  owner: {
    label: "Owner",
    description: "Full access to the organization and all administrative actions.",
    permissions: permissionOrder,
  },

  admin: {
    label: "Admin",
    description: "Manage projects, environments, API keys and organization members.",
    permissions: permissionOrder,
  },

  developer: {
    label: "Developer",
    description: "Build and manage project resources without organization administration.",
    permissions: ["api-keys", "environments", "observability"],
  },

  viewer: {
    label: "Viewer",
    description: "Read-only access to organization and project information.",
    permissions: ["observability"],
  },
};

const roleOptions = [
  {
    value: "admin",
    label: "Admin",
  },
  {
    value: "developer",
    label: "Developer",
  },
  {
    value: "viewer",
    label: "Viewer",
  },
];

function normalizeRole(value: string): Role {
  const roles = value.split(",").map((role) => role.trim());

  if (roles.includes("owner")) {
    return "owner";
  }

  if (roles.includes("admin")) {
    return "admin";
  }

  if (roles.includes("developer")) {
    return "developer";
  }

  return "viewer";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
  }).format(new Date(value));
}

export function TeamMembers({
  organizationId,
  currentUserId,
  currentRole,
  members,
  invitations,
}: TeamMembersProps) {
  const router = useRouter();

  const searchId = useId();
  const emailId = useId();
  const roleId = useId();

  const [view, setView] = useState<View>("members");

  const [query, setQuery] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [inviteOpen, setInviteOpen] = useState(false);

  const [email, setEmail] = useState("");

  const [role, setRole] = useState<InviteRole>("developer");

  const [invitePending, setInvitePending] = useState(false);

  const [inviteError, setInviteError] = useState<AuthError | null>(null);

  const [cancellingInvitationId, setCancellingInvitationId] = useState<string | null>(null);

  const [invitationError, setInvitationError] = useState<AuthError | null>(null);

  const [memberError, setMemberError] = useState<AuthError | null>(null);

  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);

  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

  const currentRoles = currentRole.split(",").map((item) => item.trim());

  const currentIsOwner = currentRoles.includes("owner");

  const currentIsAdmin = currentRoles.includes("admin");

  const canManage = currentIsOwner || currentIsAdmin;

  const term = query.trim().toLowerCase();

  const visibleMembers = useMemo(
    () =>
      term
        ? members.filter(
            (member) =>
              member.email.toLowerCase().includes(term) || member.name.toLowerCase().includes(term),
          )
        : members,
    [members, term],
  );

  const visibleInvites = useMemo(
    () =>
      term
        ? invitations.filter((invite) => invite.email.toLowerCase().includes(term))
        : invitations,
    [invitations, term],
  );

  const selectableMembers = visibleMembers.filter((member) => {
    const memberRole = normalizeRole(member.role);

    return canManage && memberRole !== "owner" && member.userId !== currentUserId;
  });

  const allSelected =
    selectableMembers.length > 0 && selectableMembers.every((member) => selected.has(member.id));

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(selectableMembers.map((member) => member.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }

      return next;
    });
  }

  function closeInvite() {
    if (invitePending) {
      return;
    }

    setInviteOpen(false);
    setEmail("");
    setRole("developer");
    setInviteError(null);
  }

  async function handleInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setInviteError(null);

    const validation = inviteOrganizationMemberInputSchema.safeParse({
      email,
      organizationId,
      role,
    });

    if (!validation.success) {
      setInviteError(
        authError(
          validation.error.issues[0]?.path[0] === "email"
            ? "INVALID_INVITATION_EMAIL"
            : "INVALID_INVITATION_ROLE",
        ),
      );

      return;
    }

    setInvitePending(true);

    const result = await authClient.organization.inviteMember(validation.data);

    if (result.error) {
      setInviteError(toOrganizationInvitationError(result.error, "send"));

      setInvitePending(false);
      return;
    }

    setInvitePending(false);

    setEmail("");
    setRole("developer");
    setInviteOpen(false);
    setView("invitations");

    router.refresh();
  }

  async function cancelInvitation(invitationId: string) {
    setInvitationError(null);

    setCancellingInvitationId(invitationId);

    const result = await authClient.organization.cancelInvitation({
      invitationId,
    });

    if (result.error) {
      setInvitationError(toOrganizationInvitationError(result.error, "cancel"));

      setCancellingInvitationId(null);

      return;
    }

    setCancellingInvitationId(null);

    router.refresh();
  }

  async function updateRole(member: Member, role: InviteRole) {
    setMemberError(null);

    const validation = updateOrganizationMemberRoleInputSchema.safeParse({
      memberId: member.id,
      organizationId,
      role,
    });

    if (!validation.success) {
      setMemberError(authError("INVALID_MEMBER_ROLE"));

      return;
    }

    setUpdatingMemberId(member.id);

    const result = await authClient.organization.updateMemberRole(validation.data);

    if (result.error) {
      setMemberError(toOrganizationMemberError(result.error, "update-role"));

      setUpdatingMemberId(null);

      return;
    }

    setUpdatingMemberId(null);

    router.refresh();
  }

  async function removeMember(member: Member) {
    if (!window.confirm(`Remove ${member.name} from this organization?`)) {
      return;
    }

    setMemberError(null);

    const validation = removeOrganizationMemberInputSchema.safeParse({
      memberIdOrEmail: member.id,
      organizationId,
    });

    if (!validation.success) {
      setMemberError(authError("ORGANIZATION_MEMBER_NOT_FOUND"));

      return;
    }

    setRemovingMemberId(member.id);

    const result = await authClient.organization.removeMember(validation.data);

    if (result.error) {
      setMemberError(toOrganizationMemberError(result.error, "remove"));

      setRemovingMemberId(null);

      return;
    }

    setRemovingMemberId(null);

    setSelected((current) => {
      const next = new Set(current);

      next.delete(member.id);

      return next;
    });

    router.refresh();
  }

  async function removeSelected() {
    const targets = members.filter((member) => selected.has(member.id));

    if (targets.length === 0) {
      return;
    }

    if (
      !window.confirm(
        `Remove ${targets.length} selected member${
          targets.length === 1 ? "" : "s"
        } from this organization?`,
      )
    ) {
      return;
    }

    setMemberError(null);

    for (const member of targets) {
      const validation = removeOrganizationMemberInputSchema.safeParse({
        memberIdOrEmail: member.id,
        organizationId,
      });

      if (!validation.success) {
        setMemberError(authError("ORGANIZATION_MEMBER_NOT_FOUND"));
        return;
      }

      setRemovingMemberId(member.id);

      const result = await authClient.organization.removeMember(validation.data);

      if (result.error) {
        setMemberError(toOrganizationMemberError(result.error, "remove"));

        setRemovingMemberId(null);

        return;
      }
    }

    setRemovingMemberId(null);
    setSelected(new Set());

    router.refresh();
  }

  function handleExport() {
    const rows = [
      ["name", "email", "role", "joined"],

      ...members.map((member) => [
        member.name,
        member.email,
        normalizeRole(member.role),
        formatDate(member.createdAt),
      ]),
    ];

    const csv = rows
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = "team-members.csv";

    document.body.appendChild(anchor);

    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team members"
        description="Manage all users and invites associated with your organization."
        actions={
          canManage ? (
            <Button size="lg" onClick={() => setInviteOpen(true)}>
              <UserPlus />
              Invite users
            </Button>
          ) : null
        }
      />

      <div role="tablist" aria-label="Members view" className="flex gap-1">
        {(["members", "invitations"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={view === item}
            onClick={() => setView(item)}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm capitalize transition-colors",
              view === item
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item}

            {item === "invitations" && invitations.length > 0 ? (
              <span className="rounded-full bg-foreground/10 px-1.5 text-xs tabular-nums">
                {invitations.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <AuthErrorMessage error={view === "members" ? memberError : invitationError} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

          <Label htmlFor={searchId} className="sr-only">
            Search users
          </Label>

          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={view === "members" ? "Search users" : "Search invitations"}
            className="h-11 rounded-xl bg-card pl-10"
          />
        </div>

        <div className="flex gap-2 self-start sm:self-auto">
          {view === "members" && selected.size > 0 && canManage ? (
            <Button
              variant="destructive"
              onClick={removeSelected}
              disabled={removingMemberId !== null}
            >
              {removingMemberId ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              Remove selected
            </Button>
          ) : null}

          {view === "members" ? (
            <Button variant="outline" onClick={handleExport}>
              <Download />
              Export
            </Button>
          ) : null}
        </div>
      </div>

      {view === "members" ? (
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[46rem] text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                <TableHead scope="col" className="w-10 px-2 pb-3">
                  <Checkbox
                    aria-label="Select all members"
                    checked={allSelected}
                    disabled={!canManage || selectableMembers.length === 0}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                  />
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Email
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Name
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Role
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Permissions
                </TableHead>

                <TableHead scope="col" className="w-12 pb-3">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {visibleMembers.map((member) => {
                const memberRole = normalizeRole(member.role);

                const isCurrentUser = member.userId === currentUserId;

                const isOwner = memberRole === "owner";

                const canEditMember = canManage && !isOwner;

                const canRemoveMember = canEditMember && !isCurrentUser;

                return (
                  <TableRow key={member.id} className="border-b last:border-0">
                    <TableCell className="px-2 py-4">
                      <Checkbox
                        aria-label={`Select ${member.email}`}
                        checked={selected.has(member.id)}
                        disabled={!canRemoveMember}
                        onCheckedChange={(checked) => toggleOne(member.id, checked === true)}
                      />
                    </TableCell>

                    <TableCell className="break-all px-2 py-4 text-[0.9375rem]">
                      {member.email}

                      {isCurrentUser ? (
                        <span className="ml-2 text-xs text-muted-foreground">You</span>
                      ) : null}
                    </TableCell>

                    <TableCell className="px-2 py-4 text-muted-foreground">{member.name}</TableCell>

                    <TableCell className="px-2 py-4">
                      {canEditMember ? (
                        <SimpleSelect
                          value={memberRole}
                          onValueChange={(value) => updateRole(member, value as InviteRole)}
                          options={roleOptions}
                          size="sm"
                          className="w-32"
                        />
                      ) : (
                        <span>{roleMeta[memberRole].label}</span>
                      )}
                    </TableCell>

                    <TableCell className="px-2 py-4">
                      <ul className="flex gap-2" aria-label={`${member.name} permissions`}>
                        {permissionOrder.map((key) => {
                          const Icon = permissionIcons[key];

                          const enabled = roleMeta[memberRole].permissions.includes(key);

                          return (
                            <li
                              key={key}
                              title={`${permissionLabels[key]}${enabled ? "" : " (no access)"}`}
                              className={cn(
                                "border-b-2 pb-0.5",
                                enabled
                                  ? "border-chart-1 text-foreground"
                                  : "border-transparent text-muted-foreground/40",
                              )}
                            >
                              <Icon className="size-4" aria-hidden="true" />

                              <span className="sr-only">
                                {permissionLabels[key]}: {enabled ? "allowed" : "not allowed"}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      {canRemoveMember ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${member.name}`}
                          disabled={
                            removingMemberId === member.id || updatingMemberId === member.id
                          }
                          onClick={() => removeMember(member)}
                        >
                          {removingMemberId === member.id ? (
                            <LoaderCircle className="animate-spin" />
                          ) : (
                            <Trash2 />
                          )}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {visibleMembers.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No users match your search.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[34rem] text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Email
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Role
                </TableHead>

                <TableHead scope="col" className="px-2 pb-3 font-normal">
                  Expires
                </TableHead>

                <TableHead scope="col" className="w-12 pb-3">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {visibleInvites.map((invite) => {
                const inviteRole = normalizeRole(invite.role);

                return (
                  <TableRow key={invite.id} className="border-b last:border-0">
                    <TableCell className="break-all px-2 py-4 text-[0.9375rem]">
                      {invite.email}
                    </TableCell>

                    <TableCell className="px-2 py-4">{roleMeta[inviteRole].label}</TableCell>

                    <TableCell className="px-2 py-4 text-muted-foreground">
                      {formatDate(invite.expiresAt)}
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      {canManage ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Cancel invitation for ${invite.email}`}
                          disabled={cancellingInvitationId === invite.id}
                          onClick={() => cancelInvitation(invite.id)}
                        >
                          {cancellingInvitationId === invite.id ? (
                            <LoaderCircle className="animate-spin" />
                          ) : (
                            <Trash2 />
                          )}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {visibleInvites.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No pending invitations.
            </p>
          ) : null}
        </div>
      )}

      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => (open ? setInviteOpen(true) : closeInvite())}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleInvite} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Invite users</DialogTitle>

              <DialogDescription>
                They will receive an email with a link to join this organization.
              </DialogDescription>
            </DialogHeader>

            <AuthErrorMessage error={inviteError} />

            <div className="grid gap-2">
              <Label htmlFor={emailId}>Email</Label>

              <Input
                id={emailId}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@company.com"
                className="h-10 rounded-xl"
                required
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={roleId}>Role</Label>

              <SimpleSelect
                id={roleId}
                value={role}
                onValueChange={(value) => setRole(value as InviteRole)}
                options={roleOptions}
                className="w-full"
              />

              <p className="text-sm text-muted-foreground">{roleMeta[role].description}</p>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeInvite} disabled={invitePending}>
                Cancel
              </Button>

              <Button type="submit" disabled={invitePending || !email.trim()}>
                {invitePending ? <LoaderCircle className="animate-spin" /> : null}
                Send invite
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
