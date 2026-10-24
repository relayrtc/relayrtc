import type { HTMLAttributes, ReactNode } from "react";
import { EmptyState } from "./empty-state";
import { LoadingSkeleton } from "./skeleton";
import type { IconName } from "./icon";

export function PanelMessage({ children, className = "account-panel-message", ...props }: HTMLAttributes<HTMLParagraphElement> & { children?: ReactNode }) {
  const text = typeof children === "string" ? children.trim() : "";
  if (/^Loading\b|^Getting\b|^Please wait/i.test(text)) return <LoadingSkeleton label={text} rows={3} />;
  if (/^No\b|^Nothing\b|unavailable\.$/i.test(text)) {
    let icon: IconName = "info", description = "Try another period or adjust your filters.";
    if (/api key/i.test(text)) { icon = "secretKeys"; description = "Create an API key to connect your application to this environment."; }
    else if (/webhook|endpoint|deliver/i.test(text)) { icon = "link"; description = "Webhook activity will appear here when events are delivered."; }
    else if (/recording/i.test(text)) { icon = "recording"; description = "Record a broadcast to see your recordings here."; }
    else if (/clip/i.test(text)) { icon = "clip"; description = "Save a moment from your stream to create a clip."; }
    else if (/schedule|broadcast/i.test(text)) { icon = "calendar"; description = "Plan your next broadcast and it will appear here."; }
    else if (/member|invitation/i.test(text)) { icon = "users"; description = "Invite your team to work together in this organization."; }
    else if (/room|participant|connection/i.test(text)) { icon = "rooms"; description = "Connection activity will appear when participants join."; }
    else if (/source|stream/i.test(text)) { icon = "streams"; description = "Connect a source to start sending media."; }
    else if (/activity|event|attempt|session/i.test(text)) { icon = "history"; description = "New activity will appear here as it happens."; }
    if (/unavailable/i.test(text)) description = "Refresh this view to try loading the latest data.";
    else if (/match|filter|search/i.test(text)) description = "Try a different search or adjust your filters.";
    return <EmptyState icon={icon} title={text.replace(/\.$/, "")} description={description} />;
  }
  return <p {...props} className={className}>{children}</p>;
}
