import { getAuthRuntime } from '@/lib/auth-server'
import { getCurrentOrganizations, getCurrentSession } from '@/lib/auth-session'
import { getProjectDetails, listOrganizationProjects } from '@/lib/projects/project-service'
import type { ConsoleInvitation, ConsoleOrganization, ConsoleOrganizationMember } from '@/lib/console-types'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { schema } from '@relayrtc/database'
import { eq } from 'drizzle-orm'

export async function requireConsoleSession(redirectPath = '/') {
  const session = await getCurrentSession()
  if (!session) {
    redirect(`/auth/login?redirect=${encodeURIComponent(redirectPath)}`)
  }
  return session
}

export async function getConsoleOrganizations(): Promise<ConsoleOrganization[]> {
  const organizations = await getCurrentOrganizations()
  return organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    logo: organization.logo,
    createdAt: organization.createdAt,
  }))
}

export async function requireOrganization(orgId: string) {
  const session = await requireConsoleSession(`/org/${orgId}`)
  const organizations = await getConsoleOrganizations()
  const organization = organizations.find((candidate) => candidate.id === orgId)
  if (!organization) notFound()
  const [state] = await getAuthRuntime().database.select({ status: schema.organization.status })
    .from(schema.organization).where(eq(schema.organization.id, orgId))
  if (!state) notFound()
  if (state.status === 'deleting') redirect(`/cleanup/organization/${encodeURIComponent(orgId)}`)
  return { session, organizations, organization }
}

export async function getOrganizationProjects(orgId: string, userId: string) {
  const result = await listOrganizationProjects(
    { database: getAuthRuntime().database, userId },
    orgId,
  )
  return result.data ?? []
}

export async function requireProject(orgId: string, projectId: string) {
  const { session, organizations, organization } = await requireOrganization(orgId)
  const result = await getProjectDetails(
    { database: getAuthRuntime().database, userId: session.user.id },
    projectId,
  )
  if (!result.data || result.data.project.organizationId !== orgId) notFound()
  if (result.data.project.status === 'deleting') redirect(`/cleanup/project/${encodeURIComponent(projectId)}`)
  const projects = await getOrganizationProjects(orgId, session.user.id)
  return {
    session,
    organizations,
    organization,
    projects,
    ...result.data,
  }
}

export async function getOrganizationManagementData(orgId: string, userId: string) {
  const requestHeaders = await headers()
  const auth = getAuthRuntime().auth
  const membersResult = await auth.api.listMembers({
    headers: requestHeaders,
    query: { organizationId: orgId },
  }).catch(() => ({ members: [], total: 0 }))

  const currentMember = membersResult.members.find((member) => member.userId === userId)
  const roles = currentMember?.role.split(',').map((role) => role.trim()) ?? []
  const canManage = roles.includes('owner') || roles.includes('admin')
  const isOwner = roles.includes('owner')

  const invitations = canManage
    ? await auth.api.listInvitations({
        headers: requestHeaders,
        query: { organizationId: orgId },
      }).catch(() => [])
    : []

  const now = Date.now()
  const members: ConsoleOrganizationMember[] = membersResult.members.map((member) => ({
    id: member.id,
    userId: member.userId,
    role: member.role,
    createdAt: member.createdAt,
    user: {
      id: member.user.id,
      name: member.user.name,
      email: member.user.email,
      image: member.user.image,
    },
  }))
  const pendingInvitations: ConsoleInvitation[] = invitations
    .filter(
      (invitation) => invitation.status === 'pending' && invitation.expiresAt.getTime() > now,
    )
    .map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    }))

  return {
    canManage,
    isOwner,
    currentRole: currentMember?.role ?? '',
    members,
    invitations: pendingInvitations,
  }
}
