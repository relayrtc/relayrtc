import Link from "next/link";
import { Button } from "./button";
import { Icon } from "./icon";
import { FormFeedback } from "./auth-fields";
import { PageSkeleton } from "./skeleton";

export function WorkspaceState({ error, onRetry, title = "Loading your workspace" }: { error?: string; onRetry: () => void; title?: string }) {
  if (!error) return <PageSkeleton />;
  return <section className="content"><div className="empty-state"><div className="empty-state-icon"><Icon name="organization" size={32} /></div><h2>{error ? "Workspace unavailable" : title}</h2>{error ? <><FormFeedback error={error} /><Button onClick={onRetry}>Try again</Button></> : <p role="status">Please wait a moment…</p>}<Link className="auth-text-button" href="/organizations">Your organizations</Link></div></section>;
}
