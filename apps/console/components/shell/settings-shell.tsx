'use client'

import { ChartNoAxesCombined, ChevronLeft, History, Monitor, SlidersHorizontal, UserRound, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { LetterAvatar, OrgSwitcher } from '@/components/shell/org-switcher'
import { NavItem, NavSection } from '@/components/shell/nav-item'
import { ShellFrame } from '@/components/shell/shell-frame'
import type { ConsoleOrganization, ConsoleUser } from '@/lib/console-types'
import { routes } from '@/lib/routes'

export const orgSettingsTabs = [
  { value: 'general', label: 'General', icon: SlidersHorizontal },
  { value: 'team-members', label: 'Team Members', icon: Users },
  { value: 'audit-logs', label: 'Audit Logs', icon: History },
] as const

type Props = {
  orgId: string
  backHref: string
  organizations: ConsoleOrganization[]
  user: ConsoleUser
  children: React.ReactNode
}

export function SettingsShell({ orgId, backHref, organizations, user, children }: Props) {
  return (
    <ShellFrame logoHref={backHref} renderSidebar={(onNavigate) => (
      <Suspense fallback={null}><SettingsSidebar orgId={orgId} backHref={backHref} organizations={organizations} user={user} {...(onNavigate ? { onNavigate } : {})} /></Suspense>
    )}>{children}</ShellFrame>
  )
}

function SettingsSidebar({ orgId, backHref, organizations, user, onNavigate }: Omit<Props, 'children'> & { onNavigate?: () => void }) {
  const activeTab = useSearchParams().get('tab') ?? 'general'
  const onUsagePage = usePathname() === `/org/${orgId}/usage`
  return (
    <div className="flex h-full flex-col gap-4 px-3 pb-3 pt-4">
      <Link href={backHref} {...(onNavigate ? { onClick: onNavigate } : {})} className="flex h-9 w-fit items-center gap-2 rounded-xl px-2 text-sm font-medium transition-colors hover:bg-muted"><ChevronLeft className="size-4 text-muted-foreground" />Back</Link>
      <OrgSwitcher organizations={organizations} currentOrgId={orgId} target="settings" {...(onNavigate ? { onNavigate } : {})} />
      <nav aria-label="Settings" className="flex flex-1 flex-col gap-6 overflow-y-auto">
        <NavSection title="Organization">
          {orgSettingsTabs.map((tab) => <NavItem key={tab.value} href={routes.orgSettings(orgId, tab.value)} label={tab.label} icon={tab.icon} active={!onUsagePage && activeTab === tab.value} {...(onNavigate ? { onNavigate } : {})} />)}
          <NavItem href={`/org/${orgId}/usage`} label="Usage" icon={ChartNoAxesCombined} active={onUsagePage} {...(onNavigate ? { onNavigate } : {})} />
        </NavSection>
        <NavSection title="Personal">
          <Link href={routes.orgSettings(orgId, 'profile')} {...(onNavigate ? { onClick: onNavigate } : {})} {...(activeTab === 'profile' ? { 'aria-current': 'page' as const } : {})} className={activeTab === 'profile' ? 'flex h-9 items-center gap-3 rounded-xl bg-muted px-2 text-sm font-medium' : 'flex h-9 items-center gap-3 rounded-xl px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'}>
            <LetterAvatar name={user.name} className="rounded-full" />
            <span className="truncate">{user.name}</span>
          </Link>
          <NavItem href={routes.orgSettings(orgId, 'profile-sessions')} label="Sessions" icon={Monitor} active={!onUsagePage && activeTab === 'profile-sessions'} {...(onNavigate ? { onNavigate } : {})} />
          <NavItem href={routes.orgSettings(orgId, 'profile-audit-logs')} label="Audit Logs" icon={History} active={!onUsagePage && activeTab === 'profile-audit-logs'} {...(onNavigate ? { onNavigate } : {})} />
        </NavSection>
      </nav>
      <div className="flex items-center gap-2 border-t px-2 pt-3 text-xs text-muted-foreground"><UserRound className="size-4" /><span className="truncate">{user.email}</span></div>
    </div>
  )
}
