import { Button } from "./button";
import { FormFeedback } from "./auth-fields";
import type { ReportQuality } from "@/lib/reporting-types";
import { LoadingSkeleton } from "./skeleton";

export function ReportingState({ error, loading, onRetry, label = "report" }: { error: string; loading: boolean; onRetry: () => void; label?: string }) {
  return <div className="developer-dialog-stack reporting-state"><FormFeedback error={error} />{loading && !error ? <LoadingSkeleton label={`Loading ${label}`} rows={4} /> : error && <Button onClick={onRetry}>Try again</Button>}</div>;
}
export function ReportCoverage({ quality }: { quality: ReportQuality }) {
  return <p className="account-section-note">{quality.sessionHistory === "partial" ? "Session history is partial. " : ""}{quality.messageHistory === "partial" ? "Message history is partial. " : ""}{quality.turnTraffic === "unavailable" ? "TURN measurements are unavailable for this period. " : quality.turnTraffic === "partial" ? "TURN totals contain partial observations. " : "TURN totals use server allocation observations. "}SFU egress includes room export traffic; relayed traffic can appear in both SFU and TURN totals.</p>;
}
