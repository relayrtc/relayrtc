import { Icon, type IconName } from "./icon";

export function EmptyState({ title, description, icon = "info", compact = false }: { title: string; description?: string; icon?: IconName; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "empty-state-compact" : "streams-empty"}`} role="status"><div className="empty-state-icon"><Icon name={icon} size={compact ? 24 : 32} /></div><h2>{title}</h2>{description && <p>{description}</p>}</div>;
}
