"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AccountAvatar } from "@/ui/account-avatar";
import { Icon, Logo, type IconName } from "@/ui/icon";
import { useAccount } from "./account-provider";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { WorkspaceGate } from "./workspace-gate";
import { LegalLinks } from "@/ui/legal-links";

const navigation: { label: string; href: string; icon: IconName }[] = [
  { label: "Rooms", href: "/rooms", icon: "rooms" },
  { label: "Streams", href: "/streams", icon: "streams" },
  { label: "Analytics", href: "/analytics", icon: "analytics" },
  { label: "Usage", href: "/usage", icon: "usage" },
  { label: "Activity", href: "/activity", icon: "history" },
  { label: "Developer", href: "/developer", icon: "secretKeys" },
  { label: "Account", href: "/account", icon: "account" },
];
const titles: Record<string, string> = { "/": "Rooms", "/rooms": "Rooms", "/streams": "Streams", "/analytics": "Analytics", "/usage": "Usage", "/activity": "Activity", "/account": "Account", "/account/sessions": "Sessions", "/account/activity": "Security Activity", "/organizations": "Organizations", "/projects": "Projects" };

export const footerLinks = { docs: "https://docs.relayrtc.com" };

export function FooterLinks() {
  return <div className="footer-links"><a href={footerLinks.docs} target="_blank" rel="noreferrer">Docs</a><span className="footer-separator" aria-hidden="true">·</span><LegalLinks /></div>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { account } = useAccount();
  if (pathname.startsWith("/auth") || pathname === "/onboarding" || pathname.startsWith("/invitations/")) return children;
  const workspacePage = ["/rooms", "/realtime", "/streams", "/analytics", "/usage", "/activity", "/developer"].some(path => pathname === path || pathname.startsWith(`${path}/`));
  const title = pathname.startsWith("/cleanup/") ? "Deletion progress" : pathname.startsWith("/org/") ? "Opening workspace" : pathname.startsWith("/activity/") ? "Activity details" : pathname === "/realtime" ? "Realtime" : pathname === "/developer" || pathname.endsWith("/developer") ? "Developer Controls" : pathname.startsWith("/organizations/") ? pathname.endsWith("/members") ? "Team Members" : pathname.endsWith("/activity") ? "Organization Activity" : "Organization" : pathname.startsWith("/projects/") ? pathname.endsWith("/api-keys") ? "API keys" : pathname.endsWith("/webhooks") ? "Webhooks" : pathname.includes("/webhooks/") ? "Webhook" : "Project" : undefined;
  const isAccount = pathname.startsWith("/account");
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`) || (href === "/rooms" && pathname === "/realtime") || (href === "/developer" && /^\/projects\/[^/]+\/(?:developer|api-keys|webhooks)(?:\/|$)/.test(pathname));
  return <div className="app-shell">
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar-brand"><Link href="/" className="brand"><Logo /><span>Relayrtc</span></Link><Link href="/account" className={`account-link ${isAccount ? "account-link-active" : ""}`} aria-label="Account settings"><AccountAvatar size={22.05} name={account.user.name} image={account.user.image} /></Link></div>
      <WorkspaceSwitcher />
      <nav className="sidebar-nav">{navigation.map(item => <Link key={item.href} href={item.href} className={`nav-item ${isActive(item.href) ? "nav-item-active" : ""}`} aria-current={isActive(item.href) ? "page" : undefined}><Icon name={item.icon} /><span>{item.label}</span></Link>)}</nav>
      <footer className="sidebar-footer"><FooterLinks /></footer>
    </aside>
    <div className="main-column">
      <header className="page-header"><WorkspaceSwitcher mobile /><h1>{title ?? (pathname.startsWith("/rooms/") ? pathname.endsWith("/audit") ? "Room Audit Log" : pathname.endsWith("/invitations") ? "Room Invitations" : "Room Overview" : pathname.startsWith("/streams/") ? "Stream Overview" : titles[pathname] ?? "Account")}</h1></header>
      <main id="main-content">{workspacePage ? <WorkspaceGate>{children}</WorkspaceGate> : children}</main>
    </div>
    <nav className="bottom-nav" aria-label="Mobile navigation">{navigation.filter(item => !["/usage", "/activity", "/account"].includes(item.href)).map(item => <Link key={item.href} href={item.href} aria-label={item.label} aria-current={isActive(item.href) ? "page" : undefined} className="bottom-nav-link"><Icon name={item.icon} size={25.2} /></Link>)}<Link href="/account" aria-label="Account settings" aria-current={isAccount ? "page" : undefined} className={`bottom-account ${isAccount ? "bottom-account-active" : ""}`}><AccountAvatar size={25.2} name={account.user.name} image={account.user.image} /></Link></nav>
  </div>;
}
