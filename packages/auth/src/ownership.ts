import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { APIError } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import { generateResourceSlug } from "./resource-slug.js";
import { recordAudit, setUserAuditContext } from "./audit.js";

import { authError, type AuthError, type AuthErrorCode } from "./errors.js";

const ownerRoleProtectedError = {
  code: "OWNER_ROLE_PROTECTED",
  message: "Organization ownership can only be changed through ownership transfer",
} as const;

const hasRole = (roles: string, role: string): boolean =>
  roles.split(",").some((value) => value.trim() === role);

export const organizationOwnershipHooks = {
  beforeCreateOrganization: async ({ organization }: { organization: { name?: string; slug?: string } }) => ({
    data: {
      ...organization,
      slug: generateResourceSlug(organization.name ?? "", "organization"),
    },
  }),
  beforeUpdateOrganization: async ({ organization }: { organization: { slug?: string } }) => {
    if ("slug" in organization) {
      throw APIError.from("BAD_REQUEST", {
        code: "ORGANIZATION_SLUG_IMMUTABLE",
        message: "Organization slugs cannot be changed",
      });
    }
  },
  beforeRemoveMember: ({ member }: { member: { role: string } }) => {
    if (hasRole(member.role, "owner")) {
      return Promise.reject(APIError.from("FORBIDDEN", ownerRoleProtectedError));
    }

    return Promise.resolve();
  },
  beforeUpdateMemberRole: ({
    member,
    newRole,
  }: {
    member: { role: string };
    newRole: string;
  }) => {
    if (hasRole(member.role, "owner") || hasRole(newRole, "owner")) {
      return Promise.reject(APIError.from("FORBIDDEN", ownerRoleProtectedError));
    }

    return Promise.resolve();
  },
};

export interface TransferOrganizationOwnershipOptions {
  currentUserId: string;
  database: RelayKitDatabase;
  organizationId: string;
  targetMemberId: string;
}

export interface TransferredOrganizationOwnership {
  newOwnerMemberId: string;
  previousOwnerMemberId: string;
}

export type TransferOrganizationOwnershipResult =
  { data: TransferredOrganizationOwnership; error: null } | { data: null; error: AuthError };

const transferError = (code: AuthErrorCode): TransferOrganizationOwnershipResult => ({
  data: null,
  error: authError(code),
});

export const transferOrganizationOwnership = async ({
  currentUserId,
  database,
  organizationId,
  targetMemberId,
}: TransferOrganizationOwnershipOptions): Promise<TransferOrganizationOwnershipResult> => {
  try {
    return await database.transaction(async (transaction) => {
      await setUserAuditContext(transaction, currentUserId);
      const organizations = await transaction
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, organizationId))
        .for("update");

      if (organizations.length === 0) {
        return transferError("ORGANIZATION_NOT_FOUND");
      }

      const members = await transaction
        .select({
          id: schema.member.id,
          role: schema.member.role,
          userId: schema.member.userId,
        })
        .from(schema.member)
        .where(eq(schema.member.organizationId, organizationId))
        .for("update");
      const currentOwner = members.find(
        (member) => member.userId === currentUserId && hasRole(member.role, "owner"),
      );

      if (!currentOwner) {
        return transferError("OWNERSHIP_TRANSFER_FORBIDDEN");
      }

      const owners = members.filter((member) => hasRole(member.role, "owner"));
      const targetMember = members.find((member) => member.id === targetMemberId);

      if (
        !targetMember ||
        targetMember.id === currentOwner.id ||
        hasRole(targetMember.role, "owner")
      ) {
        return transferError("OWNERSHIP_TRANSFER_TARGET_INVALID");
      }

      const updatedAt = new Date();
      await transaction
        .update(schema.member)
        .set({ role: "viewer", updatedAt })
        .where(
          and(
            eq(schema.member.organizationId, organizationId),
            inArray(
              schema.member.id,
              owners.map((owner) => owner.id),
            ),
          ),
        );
      await transaction
        .update(schema.member)
        .set({ role: "owner", updatedAt })
        .where(
          and(
            eq(schema.member.id, targetMember.id),
            eq(schema.member.organizationId, organizationId),
          ),
        );

      const [actor] = await transaction.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, currentUserId));
      await recordAudit(transaction, { actor: { type: "USER", id: currentUserId, name: actor?.name ?? "User" },
        organizationId, resourceType: "organization", resourceId: organizationId,
        action: "organization.ownership_transferred", outcome: "SUCCESS" });
      return {
        data: {
          newOwnerMemberId: targetMember.id,
          previousOwnerMemberId: currentOwner.id,
        },
        error: null,
      };
    });
  } catch {
    return transferError("OWNERSHIP_TRANSFER_FAILED");
  }
};
