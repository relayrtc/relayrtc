import Link from "next/link";

export function ReportingNavigation({ active }: { active: "analytics" | "usage" | "activity" }) {
  return <nav className="segmented-control reporting-navigation" aria-label="Reporting navigation">{["analytics", "usage", "activity"].map(value => <Link key={value} className={active === value ? "segment-active" : ""} aria-current={active === value ? "page" : undefined} href={`/${value}`}>{value[0].toUpperCase() + value.slice(1)}</Link>)}</nav>;
}
