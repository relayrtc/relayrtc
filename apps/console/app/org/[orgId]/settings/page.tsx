import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { OrgGeneral } from '@/components/settings/org-general'
import { ProfileSettings } from '@/components/settings/profile-settings'
import { AccountAuditLog } from '@/components/settings/account-audit-log'
import { AccountSessions } from '@/components/settings/account-sessions'
import { TeamMembers } from '@/components/settings/team-members'
import { getAuthRuntime } from '@/lib/auth-server'

export const metadata: Metadata = {
  title: 'Organization settings',
  description:
    'Manage your organization, members and invitations.',
}

export const dynamic = 'force-dynamic'

export default async function OrgSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{
    orgId: string
  }>
  searchParams: Promise<{
    tab?: string
  }>
}) {
  const [{ orgId }, query] =
    await Promise.all([
      params,
      searchParams,
    ])

  // Personal account data and actions are fetched by the browser from Fastify.
  // The surrounding console layout continues to enforce shell access.
  if (query.tab === 'profile') return <ProfileSettings />
  if (query.tab === 'profile-sessions') return <AccountSessions />
  if (query.tab === 'profile-audit-logs') return <AccountAuditLog />
  if (query.tab === 'audit-logs') return <AccountAuditLog organizationId={orgId} />

  const runtime = getAuthRuntime()
  const requestHeaders =
    await headers()

  const session =
    await runtime.auth.api.getSession({
      headers: requestHeaders,
    })

  if (!session) {
    redirect(
      `/auth/login?redirect=${encodeURIComponent(
        `/org/${orgId}/settings`,
      )}`,
    )
  }

  const organizations =
    await runtime.auth.api.listOrganizations({
      headers: requestHeaders,
    })

  const organization =
    organizations.find(
      (item) =>
        item.id === orgId,
    )

  if (!organization) {
    redirect('/')
  }

  const memberResult =
    await runtime.auth.api.listMembers({
      headers: requestHeaders,
      query: {
        organizationId: orgId,
      },
    })

  const currentRole = memberResult.members.find(
    (member) => member.userId === session.user.id,
  )?.role ?? ''

  const roles =
    currentRole
      .split(',')
      .map((role) =>
        role.trim(),
      )

  const canManage =
    roles.includes('owner') ||
    roles.includes('admin')

  if (
    query.tab === 'team-members'
  ) {
    const invitations =
      canManage
        ? await runtime.auth.api.listInvitations(
            {
              headers:
                requestHeaders,
              query: {
                organizationId:
                  orgId,
              },
            },
          )
        : []

    // eslint-disable-next-line react-hooks/purity -- Evaluate invitation expiry once per server request.
    const now = Date.now()

    const pendingInvitations =
      invitations.filter(
        (invitation) =>
          invitation.status ===
            'pending' &&
          new Date(
            invitation.expiresAt,
          ).getTime() > now,
      )

    return (
      <TeamMembers
        organizationId={
          organization.id
        }
        currentUserId={
          session.user.id
        }
        currentRole={
          currentRole
        }
        members={memberResult.members.map(
          (member) => ({
            id: member.id,
            userId:
              member.userId,
            name:
              member.user.name,
            email:
              member.user.email,
            role: member.role,
            createdAt:
              new Date(
                member.createdAt,
              ).toISOString(),
          }),
        )}
        invitations={pendingInvitations.map(
          (invitation) => ({
            id: invitation.id,
            email:
              invitation.email,
            role:
              invitation.role,
            expiresAt:
              new Date(
                invitation.expiresAt,
              ).toISOString(),
          }),
        )}
      />
    )
  }

  return (
    <OrgGeneral
      organization={{
        id: organization.id,
        name:
          organization.name,
        slug:
          organization.slug,
        logo:
          organization.logo,
        createdAt:
          new Date(
            organization.createdAt,
          ).toISOString(),
      }}
      memberCount={
        memberResult.members.length
      }
      canManage={canManage}
      isOwner={roles.includes('owner')}
      ownershipCandidates={memberResult.members
        .filter((member) =>
          member.userId !== session.user.id &&
          !member.role.split(',').map((role) => role.trim()).includes('owner'),
        )
        .map((member) => ({
          id: member.id,
          name: member.user.name,
          email: member.user.email,
        }))}
    />
  )
}
