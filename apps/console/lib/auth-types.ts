export interface AccountOverview {
  emailVerificationRequired: boolean;
  user: { id: string; name: string; email: string; image: string | null; emailVerified: boolean; twoFactorEnabled: boolean };
  accounts: { id: string; providerId: string; accountId: string; createdAt: string }[];
  ownedOrganizations: { id: string; name: string }[];
}

export interface AccountSession {
  id: string; userAgent: string | null; ipAddress: string | null;
  createdAt: string; updatedAt: string; expiresAt: string; current: boolean;
}

export interface AuditEvent {
  id: string; occurredAt: string; actorType: string; actorId: string | null; actorName: string;
  action: string; outcome: string; resourceType: string; resourceId: string | null;
  correlationId: string | null; metadata: Record<string, unknown>;
}
export interface AuditPage { events: AuditEvent[]; nextCursor: string | null; retentionDays: number }

export type AuthResult = { twoFactorRedirect?: boolean; token?: string | null; url?: string };
