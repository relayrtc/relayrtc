import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";
import { AnimatedValue } from "./sliding-number";

type Props = { icon: IconName; leading?: ReactNode; label: string; value?: ReactNode; href?: string; onClick?: () => void; trailing?: ReactNode; className?: string; ariaLabel?: string };

export function SettingsRow({ icon, leading, label, value, href, onClick, trailing, className = "", ariaLabel }: Props) {
  const content = <>{leading ?? <Icon name={icon} />}<span className="settings-label">{label}</span>{value !== undefined && value !== null && value !== "" && <span className="settings-value" title={typeof value === "string" ? value : undefined}><AnimatedValue value={value} /></span>}{trailing ?? <Icon name="chevronRight" size={17.325} className="row-chevron" />}</>;
  if (href) return <Link className={`settings-row ${className}`} href={href} aria-label={ariaLabel}>{content}</Link>;
  if (onClick) return <button type="button" className={`settings-row ${className}`} onClick={onClick} aria-label={ariaLabel}>{content}</button>;
  return <div className={`settings-row ${className}`}>{content}</div>;
}
