export default function LoadingStreamWorkspace() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <p className="text-sm text-muted-foreground">Loading stream workspace…</p>
      <div className="h-28 animate-pulse rounded-xl bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
