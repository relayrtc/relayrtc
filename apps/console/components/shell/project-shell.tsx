'use client'

import {
  BookOpen,
  ChartLine,
  CircleUserRound,
  Code2,
  Ellipsis,
  Home,
  KeyRound,
  Layers,
  LogOut,
  Server,
  Settings,
  Settings2,
  ChartPie,
  Webhook,
  Radio,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Logo } from '@/components/brand/logo'
import { NavItem, NavSection } from '@/components/shell/nav-item'
import { OrgSwitcher } from '@/components/shell/org-switcher'
import { ProjectSwitcher } from '@/components/shell/project-switcher'
import { ShellFrame } from '@/components/shell/shell-frame'
import { ThemeMenuItems } from '@/components/shell/theme-menu'
import { buttonVariants } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { authClient } from '@/lib/auth-client'
import type { ConsoleOrganization, ConsoleProject, ConsoleUser } from '@/lib/console-types'
import { routes } from '@/lib/routes'
import { cn } from '@/lib/utils'

type Props = {
  orgId: string
  projectId: string
  organizations: ConsoleOrganization[]
  projects: ConsoleProject[]
  user: ConsoleUser
  canManageProjects: boolean
  children: React.ReactNode
}

export function ProjectShell({ orgId, projectId, organizations, projects, user, canManageProjects, children }: Props) {
  return (
    <ShellFrame
      logoHref={routes.project(orgId, projectId)}
      renderSidebar={(onNavigate) => (
        <ProjectSidebar orgId={orgId} projectId={projectId} organizations={organizations} projects={projects} user={user} canManageProjects={canManageProjects} {...(onNavigate ? { onNavigate } : {})} />
      )}
    >
      {children}
    </ShellFrame>
  )
}

function ProjectSidebar({ orgId, projectId, organizations, projects, user, canManageProjects, onNavigate }: Omit<Props, 'children'> & { onNavigate?: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const base = routes.project(orgId, projectId)
  const isActive = (path: string) => (path === base ? pathname === base : pathname.startsWith(path))

  const primary = [
    { label: 'Overview', href: base, icon: Home },
    { label: 'API keys', href: `${base}/api-keys`, icon: KeyRound },
    { label: 'Environments', href: `${base}/environments`, icon: Layers },
    { label: 'Webhooks', href: `${base}/webhooks`, icon: Webhook },
    { label: 'Streams', href: `${base}/streams`, icon: Radio },
    { label: 'Usage', href: `${base}/usage`, icon: ChartLine },
    { label: 'Analytics', href: `${base}/analytics`, icon: ChartPie },
    { label: 'Project Settings', href: `${base}/settings`, icon: Settings2 },
  ]

  async function signOut() {
    await authClient.signOut()
    router.replace(routes.login)
    router.refresh()
  }

  return (
    <div className="flex h-full flex-col gap-4 px-3 pb-3 pt-4">
      <div className="flex items-center px-2"><Logo href={base} {...(onNavigate ? { onClick: onNavigate } : {})} /></div>
      <div className="flex flex-col gap-1">
        <OrgSwitcher organizations={organizations} currentOrgId={orgId} {...(onNavigate ? { onNavigate } : {})} />
        <ProjectSwitcher orgId={orgId} projects={projects} currentProjectId={projectId} canManage={canManageProjects} {...(onNavigate ? { onNavigate } : {})} />
      </div>
      <nav aria-label="Project" className="flex flex-1 flex-col gap-6 overflow-y-auto">
        <NavSection>{primary.map((item) => <NavItem key={item.href} {...item} active={isActive(item.href)} {...(onNavigate ? { onNavigate } : {})} />)}</NavSection>
        <NavSection title="Resources">
          <NavItem label="Documentation" href="https://github.com/relayrtc/relayrtc" icon={BookOpen} external />
          <NavItem label="Client SDKs" href="https://github.com/relayrtc" icon={Code2} external />
          <NavItem label="Self-hosting guide" href="https://github.com/relayrtc/relayrtc" icon={Server} external />
        </NavSection>
      </nav>
      <div className="flex items-center gap-1 border-t pt-3">
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate text-xs font-medium">{user.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'text-muted-foreground')} aria-label="Account options"><Ellipsis /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-52 rounded-xl p-1.5">
            <ThemeMenuItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href={routes.orgSettings(orgId, 'profile')} {...(onNavigate ? { onClick: onNavigate } : {})} />}><CircleUserRound />Account</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void signOut()}><LogOut />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Link href={routes.orgSettings(orgId)} {...(onNavigate ? { onClick: onNavigate } : {})} aria-label="Organization settings" className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'text-muted-foreground')}><Settings /></Link>
      </div>
    </div>
  )
}
