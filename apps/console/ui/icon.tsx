import { createElement, type CSSProperties, type ReactNode } from "react";
import iconData from "./icon-data.json";

type SvgNode = { tag: string; props: Record<string, unknown>; children: SvgNode[] };
type OriginalIconName = keyof typeof iconData;
export type IconName = OriginalIconName | "logo" | "chevronRight" | "chevronLeft" | "chevronDown" | "logout" | "more" | "check" | "search" | "link" | "rooms" | "users" | "analytics" | "usage" | "ingress" | "egress" | "turn" | "quality" | "signaling" | "recording" | "globe" | "download" | "calendar" | "info" | "streams" | "clip" | "history" | "play" | "stop" | "organization" | "project" | "eye" | "device" | "shield";

function renderNode(node: SvgNode, key: number): ReactNode {
  return createElement(node.tag, { ...node.props, key }, ...node.children.map(renderNode));
}

export function Logo({ className = "" }: { className?: string }) {
  return <img src="/relayrtc-logo.svg" className={`relayrtc-logo ${className}`} width="30" height="28" alt="" aria-hidden="true" />;
}

export function Icon({ name, size = 20.475, className = "", style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  if (name === "logo") return <span className={`icon ${className}`} style={{ width: size, height: size, ...style }}><Logo /></span>;
  if (name in iconData) {
    const node = iconData[name as OriginalIconName] as SvgNode;
    return createElement("svg", { ...node.props, width: size, height: size, className: `icon ${className}`, style, "aria-hidden": true }, ...node.children.map(renderNode));
  }
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
    {name === "eye" && <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>}
    {name === "device" && <><rect x="3" y="3" width="18" height="13" rx="3" /><path d="M8 21h8m-4-5v5" /></>}
    {name === "shield" && <><path d="M12 2 3.5 6v6c0 4.5 4 8 8.5 10 4.5-2 8.5-5.5 8.5-10V6L12 2Z" /><path d="m8 12 3 3 5-6" /></>}
    {name === "chevronRight" && <path d="m10 7 5 5-5 5" />}
    {name === "chevronLeft" && <path d="m14 6-6 6 6 6" />}
    {name === "chevronDown" && <path d="m7 10 5 5 5-5" />}
    {name === "streams" && <><rect x="3" y="4" width="18" height="16" rx="5" /><path d="m10 8 6 4-6 4V8Z" /></>}
    {name === "clip" && <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="m8.4 7.8 12.6 12M8.4 16.2 21 4M12 12l-2 2" /></>}
    {name === "history" && <><path d="M3 10a9 9 0 1 1 1.3 7M3 4v6h6M12 7v5l3 2" /></>}
    {name === "play" && <path d="m7 4 14 8-14 8V4Z" />}
    {name === "stop" && <rect x="5" y="5" width="14" height="14" rx="3" />}
    {name === "organization" && <><rect x="4" y="3" width="16" height="18" rx="4" /><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 21v-5h6v5" /></>}
    {name === "project" && <><path d="M4 7a3 3 0 0 1 3-3h3l2 3h5a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z" /><path d="M9 12h6m-6 4h3" /></>}
    {name === "analytics" && <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M7.5 15.5v-4M12 15.5v-8M16.5 15.5V10" /></>}
    {name === "usage" && <><path d="M11 3a9 9 0 1 0 10 10H11V3Z" /><path d="M15 3.5a7 7 0 0 1 5.5 5.5H15V3.5Z" /></>}
    {name === "ingress" && <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 7v10m-4-4 4 4 4-4" /></>}
    {name === "egress" && <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 17V7m-4 4 4-4 4 4" /></>}
    {name === "turn" && <><path d="M4 8h12a4 4 0 0 1 0 8H8M7 5 4 8l3 3m4 2-3 3 3 3" /></>}
    {name === "quality" && <><path d="M3 12h4l3-7 4 14 3-7h4" /></>}
    {name === "signaling" && <><rect x="3" y="4" width="18" height="15" rx="5" /><path d="m7 10 2 2-2 2m5 0h5M8 19v2" /></>}
    {name === "recording" && <><rect x="3" y="5" width="18" height="14" rx="5" /><circle cx="12" cy="12" r="3" /></>}
    {name === "globe" && <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>}
    {name === "download" && <><path d="M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>}
    {name === "calendar" && <><rect x="3" y="5" width="18" height="16" rx="4" /><path d="M7 3v4m10-4v4M3 11h18m-13 5h3" /></>}
    {name === "info" && <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-9v.1" /></>}
    {name === "logout" && <><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M14 8l4 4-4 4M9 12h9" /></>}
    {name === "more" && <g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></g>}
    {name === "check" && <path d="m5 12 4 4L19 6" />}
    {name === "search" && <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>}
    {name === "rooms" && <><path d="M8 8V6.5A3.5 3.5 0 0 1 11.5 3h6A3.5 3.5 0 0 1 21 6.5v6a3.5 3.5 0 0 1-3.5 3.5H16" /><rect x="3" y="8" width="13" height="13" rx="3.5" /><path d="M7.5 12.5h4M7.5 16.5h2" /></>}
    {name === "users" && <><circle cx="9" cy="8" r="3.5" /><path d="M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3A4.5 4.5 0 0 1 15 18.5V20M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.2a4.5 4.5 0 0 1 3 4.3V20" /></>}
    {name === "link" && <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1) scale(.9)" /></>}
  </svg>;
}
