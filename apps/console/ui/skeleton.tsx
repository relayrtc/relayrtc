import type { CSSProperties } from "react";

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`skeleton ${className}`} style={style} />;
}

export function LoadingSkeleton({ label = "Loading", rows = 3, className = "" }: { label?: string; rows?: number; className?: string }) {
  return <div className={`loading-skeleton ${className}`} role="status" aria-label={label} aria-busy="true"><span className="sr-only">{label}</span><div className="panel">{Array.from({ length: rows }, (_, index) => <div className="skeleton-row" key={index}><Skeleton className="skeleton-icon" /><span className="skeleton-copy"><Skeleton style={{ width: `${56 + index % 3 * 12}%` }} /><Skeleton className="skeleton-description" style={{ width: `${35 + index % 3 * 10}%` }} /></span><Skeleton className="skeleton-value" /></div>)}</div></div>;
}

export function PageSkeleton() {
  return <section className="content"><Skeleton className="skeleton-heading" /><LoadingSkeleton rows={4} label="Loading page" /></section>;
}
