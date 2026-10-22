"use client";

import {
  BookOpen,
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
  Webhook,
  ChevronDown,
  Activity,
  Film,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { NavItem, NavSection } from "@/components/shell/nav-item";
import { OrgSwitcher } from "@/components/shell/org-switcher";
import { ProjectSwitcher } from "@/components/shell/project-switcher";
import { ShellFrame } from "@/components/shell/shell-frame";
import { ThemeMenuItems } from "@/components/shell/theme-menu";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import type { ConsoleOrganization, ConsoleProject, ConsoleUser } from "@/lib/console-types";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type Props = {
  orgId: string;
  projectId: string;
  organizations: ConsoleOrganization[];
  projects: ConsoleProject[];
  user: ConsoleUser;
  canManageProjects: boolean;
  children: React.ReactNode;
};

export function ProjectShell({
  orgId,
  projectId,
  organizations,
  projects,
  user,
  canManageProjects,
  children,
}: Props) {
  return (
    <ShellFrame
      logoHref={routes.project(orgId, projectId)}
      renderSidebar={(onNavigate) => (
        <ProjectSidebar
          orgId={orgId}
          projectId={projectId}
          organizations={organizations}
          projects={projects}
          user={user}
          canManageProjects={canManageProjects}
          {...(onNavigate ? { onNavigate } : {})}
        />
      )}
    >
      <ProjectReportingNav base={routes.project(orgId, projectId)} />
      {children}
    </ShellFrame>
  );
}

function ProjectSidebar({
  orgId,
  projectId,
  organizations,
  projects,
  user,
  canManageProjects,
  onNavigate,
}: Omit<Props, "children"> & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const media = pathname.includes("/activity/assets") || pathname.endsWith("/media") || (pathname.endsWith("/activity") && search.get("view") === "assets");
  const base = routes.project(orgId, projectId);
  const isActive = (path: string) =>
    path === base ? pathname === base : pathname.startsWith(path);

  const configuration = [
    { label: "API keys", href: `${base}/api-keys`, icon: KeyRound },
    { label: "Environments", href: `${base}/environments`, icon: Layers },
    { label: "Webhooks", href: `${base}/webhooks`, icon: Webhook },
    { label: "Project settings", href: `${base}/settings`, icon: Settings2 },
  ];
  const configuring = configuration.some((item) => isActive(item.href));
  const primary = [
    { label: "Overview", description: "Usage, health and activity", href: base, icon: Home },
    { label: "Realtime", description: "Rooms and livestreams", href: `${base}/realtime`, icon: Activity },
    { label: "Media", description: "Recordings, clips and DVR", href: `${base}/media`, icon: Film },
  ];

  async function signOut() {
    await authClient.signOut();
    router.replace(routes.login);
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col gap-4 px-3 pb-3 pt-4">
      <div className="flex items-center px-2">
        <Logo href={base} {...(onNavigate ? { onClick: onNavigate } : {})} />
      </div>
      <div className="flex flex-col gap-1">
        <OrgSwitcher
          organizations={organizations}
          currentOrgId={orgId}
          {...(onNavigate ? { onNavigate } : {})}
        />
        <ProjectSwitcher
          orgId={orgId}
          projects={projects}
          currentProjectId={projectId}
          canManage={canManageProjects}
          {...(onNavigate ? { onNavigate } : {})}
        />
      </div>
      <nav aria-label="Project" className="flex flex-1 flex-col gap-6 overflow-y-auto">
        <NavSection>
          {primary.map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={
                isActive(item.href) ||
                (item.href === base && (pathname.endsWith("/usage") || pathname.endsWith("/analytics"))) ||
                (item.label === "Media" && media) ||
                (item.label === "Realtime" && pathname.includes("/activity") && !media)
              }
              {...(onNavigate ? { onNavigate } : {})}
            />
          ))}
        </NavSection>
        <details open={configuring} className="group/settings">
          <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-2 py-2 text-sm text-muted-foreground hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
            <Settings2 className="size-[18px]" />
            <span className="flex-1">Settings</span>
            <ChevronDown className="size-4 transition-transform group-open/settings:rotate-180" />
          </summary>
          <div className="mt-1">
            {configuration.map((item) => (
              <NavItem
                key={item.href}
                {...item}
                active={isActive(item.href)}
                {...(onNavigate ? { onNavigate } : {})}
              />
            ))}
          </div>
        </details>
        <NavSection title="Resources">
          <NavItem
            label="Documentation"
            href="https://docs.relayrtc.com"
            icon={BookOpen}
            external
          />
          <NavItem
            label="Client SDKs"
            href="https://docs.relayrtc.com/reference/sdk/server/node/overview"
            icon={Code2}
            external
          />
          <NavItem
            label="Self-hosting guide"
            href="https://docs.relayrtc.com/self-hosting"
            icon={Server}
            external
          />
        </NavSection>
      </nav>
      <div className="flex items-center gap-1 border-t pt-3">
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate text-xs font-medium">{user.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-sm" }),
              "text-muted-foreground",
            )}
            aria-label="Account options"
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-52 rounded-xl p-1.5">
            <ThemeMenuItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              render={
                <Link
                  href={routes.orgSettings(orgId, "profile")}
                  {...(onNavigate ? { onClick: onNavigate } : {})}
                />
              }
            >
              <CircleUserRound />
              Account
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Link
          href={routes.orgSettings(orgId)}
          {...(onNavigate ? { onClick: onNavigate } : {})}
          aria-label="Organization settings"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "text-muted-foreground",
          )}
        >
          <Settings />
        </Link>
      </div>
    </div>
  );
}

function ProjectReportingNav({ base }: { base: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  if (pathname !== base && pathname !== `${base}/usage` && pathname !== `${base}/analytics`) return null;
  const query = new URLSearchParams();
  const range = search.get("range");
  const environment = search.get("environment");
  if (range) query.set("range", range);
  if (environment) query.set("environment", environment);
  return (
    <nav aria-label="Project reporting" className="mb-6 flex gap-5 border-b border-border/70">
      {[
        { path: "", label: "Summary" },
        { path: "usage", label: "Usage" },
        { path: "analytics", label: "Analytics" },
      ].map((item) => {
        const destination = item.path ? `${base}/${item.path}` : base;
        const active = pathname === destination;
        return (
          <Link
            key={item.path}
            href={`${destination}${query.size ? `?${query}` : ""}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-b-2 px-1 pb-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
