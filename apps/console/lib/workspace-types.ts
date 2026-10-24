export type WorkspaceRole = "owner" | "admin" | "developer" | "viewer";
export type Organization = {
  id: string; name: string; slug: string; logo: string | null; createdAt: string; updatedAt: string;
  status: "active" | "deleting"; role: string; memberId: string; canManage: boolean; isOwner: boolean;
};
export type Project = { id: string; organizationId: string; name: string; slug: string; status: "active" | "suspended" | "deleting" | "deleted"; createdAt: string; updatedAt: string };
export type ProjectEnvironment = {
  id: string; projectId: string; name: string; slug: string; type: "development" | "production" | "preview" | "staging" | "custom";
  deletionProtected: boolean; status: "active" | "deleting"; createdAt: string; updatedAt: string;
};
export type OrganizationMember = { id: string; userId: string; name: string; email: string; image: string | null; role: string; createdAt: string };
export type PendingInvitation = { id: string; email: string; role: string | null; expiresAt: string };
export type WorkspaceInvitation = PendingInvitation & { organizationId: string; organizationName: string; inviterEmail: string; inviterName: string };
export type OrganizationDetails = { organization: Organization; members: OrganizationMember[]; invitations: PendingInvitation[] };
export type ProjectDetails = { project: Project; environments: ProjectEnvironment[]; canManage: boolean };
export type WorkspaceSnapshot = { userId: string; organizations: Organization[]; projects: Project[]; invitations: WorkspaceInvitation[]; activeOrganizationId: string | null };
export type WorkspaceSelection = { organizationId: string | null; projectId: string | null; lastProjectIds: Record<string, string> };
export type DeletionKind = "organization" | "project" | "environment";
export type DeletionImpact = { projects: number; environments: number; apiKeys: number; rooms: number; roomsToEnd: number; connectedParticipants: number };
export type DeletionOperation = { id: string; kind: string; status: "pending" | "running" | "failed" | "completed"; attempts: number; lastError: string | null; completedAt: string | null };
export type DeletionResult = { operation: DeletionOperation | null };
