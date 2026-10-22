import { ArrowUpRight, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

export function NavItem({
  href,
  label,
  icon: Icon,
  active,
  external,
  badge,
  description,
  onNavigate,
}: {
  href: string
  label: string
  icon?: LucideIcon
  active?: boolean
  external?: boolean
  description?: string
  badge?: string
  onNavigate?: () => void
}) {
  return (
    <Link
      href={href}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      {...(active ? { 'aria-current': 'page' as const } : {})}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(
        'group flex min-h-9 items-center gap-3 rounded-xl px-2 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
        active
          ? 'bg-muted font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {Icon ? <Icon className={cn('size-[18px] shrink-0', active && 'stroke-[2.25]')} /> : null}
      <span className="min-w-0 flex-1 py-1"><span className="block truncate">{label}</span>{description && <span className="block text-[11px] font-normal text-muted-foreground">{description}</span>}</span>
      {badge ? <span className="text-xs font-normal text-brand">{badge}</span> : null}
      {external ? <ArrowUpRight className="size-4 shrink-0 opacity-70" /> : null}
    </Link>
  )
}

export function NavSection({
  title,
  children,
}: {
  title?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {title ? (
        <h3 className="px-2 pb-1.5 pt-1 text-sm font-medium text-foreground">{title}</h3>
      ) : null}
      {children}
    </div>
  )
}
