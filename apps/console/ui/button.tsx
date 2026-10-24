import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icon";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger"; icon?: IconName };

export function Button({ children, variant = "secondary", icon, className = "", ...props }: ButtonProps) {
  return <button className={`button button-${variant} ${className}`} {...props}>{icon && <Icon name={icon} size={17.325} />}{children}</button>;
}

export function ButtonLink({ href, children, icon, variant = "secondary", className = "" }: { href: string; children: ReactNode; icon?: IconName; variant?: "primary" | "secondary"; className?: string }) {
  return <Link href={href} className={`button button-${variant} ${className}`}>{icon && <Icon name={icon} size={17.325} />}{children}</Link>;
}
