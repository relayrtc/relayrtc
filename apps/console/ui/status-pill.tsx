import type { ReactNode } from "react";

export function StatusPill({ active = false, children }: { active?: boolean; children: ReactNode }) {
  return <span className={`status-pill ${active ? "status-pill-active" : ""}`}><span className="status-dot" aria-hidden="true" />{children}</span>;
}
