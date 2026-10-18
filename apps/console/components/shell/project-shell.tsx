"use client";

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
  Clapperboard,
  Video,
  Scissors,
  CalendarClock,
  Users,
  ArrowLeft,
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
import { streamSections, streamWorkspaceHref } from "@/lib/stream-workspace";

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
  const base = routes.project(orgId, projectId);
  const isActive = (path: string) =>
    path === base ? pathname === base : pathname.startsWith(path);

  const match = pathname.slice(base.length).match(/^\/streams\/([^/]+)(?:\/([^/]+))?\/?$/);
  const workspaceStream = match?.[1] ? decodeURIComponent(match[1]) : null;
  const section = match?.[2] ?? "overview";
  const environmentId = search.get("environmentId") ?? "";
  const backHref = `${base}/streams${environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : ""}`;
  const sectionIcons = {
    overview: Home,
    broadcasts: Clapperboard,
    destinations: Server,
    guests: Users,
    recordings: Video,
    clips: Scissors,
    schedule: CalendarClock,
    studio: Layers,
    settings: Settings2,
  };
  const primary = workspaceStream
    ? streamSections.map((item) => ({
        label: item.label,
        href: streamWorkspaceHref(
          base,
          workspaceStream,
          environmentId,
          item.id,
          search.get("broadcastId"),
        ),
        icon: sectionIcons[item.id],
      }))
    : [
        { label: "Overview", href: base, icon: Home },
        { label: "API keys", href: `${base}/api-keys`, icon: KeyRound },
        { label: "Environments", href: `${base}/environments`, icon: Layers },
        { label: "Webhooks", href: `${base}/webhooks`, icon: Webhook },
        { label: "Rooms", href: `${base}/rooms`, icon: Users },
        { label: "Streams", href: `${base}/streams`, icon: Radio },
        { label: "Source library", href: `${base}/sources`, icon: Radio },
        { label: "Usage", href: `${base}/usage`, icon: ChartLine },
        { label: "Analytics", href: `${base}/analytics`, icon: ChartPie },
        { label: "Project Settings", href: `${base}/settings`, icon: Settings2 },
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
      {workspaceStream ? (
        <div className="space-y-3 px-2">
          <Link
            href={backHref}
            {...(onNavigate ? { onClick: onNavigate } : {})}
            className="flex h-9 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to streams
          </Link>
          <div>
            <p className="text-sm font-semibold">Stream workspace</p>
            <p className="truncate text-xs text-muted-foreground">
              {projects.find((p) => p.id === projectId)?.name}
            </p>
          </div>
        </div>
      ) : (
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
      )}
      <nav
        aria-label={workspaceStream ? "Stream" : "Project"}
        className="flex flex-1 flex-col gap-6 overflow-y-auto"
      >
        <NavSection>
          {primary.map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={
                workspaceStream
                  ? item.href.split("?")[0] ===
                    streamWorkspaceHref(base, workspaceStream, environmentId, section).split("?")[0]
                  : isActive(item.href)
              }
              {...(onNavigate ? { onNavigate } : {})}
            />
          ))}
        </NavSection>
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
