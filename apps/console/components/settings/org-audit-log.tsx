'use client'

import { AccountAuditLog } from '@/components/settings/account-audit-log'

export function OrgAuditLog({ organizationId }: { organizationId: string }) {
  return <AccountAuditLog organizationId={organizationId} />
}