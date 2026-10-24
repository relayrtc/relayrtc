import { AnimatedValue } from "@/ui/sliding-number";
import type { RuntimeOperation } from "@/lib/room-types";
import { accountTime, humanizeAction } from "@/lib/account-display";

export function RoomRuntimeStatus({ operation }: { operation: RuntimeOperation | null }) {
  if (!operation) return <p className="account-note" role="status">Cleanup progress is unavailable. Refresh to try again.</p>;
  return <div className="developer-dialog-stack" role="status"><dl className="account-detail-list"><div><dt>Cleanup</dt><dd>{humanizeAction(operation.status)}</dd></div><div><dt>Attempts</dt><dd><AnimatedValue value={operation.attempts} /></dd></div>{operation.completedAt && <div><dt>Completed</dt><dd>{accountTime(operation.completedAt)}</dd></div>}</dl><p className="account-note">{operation.status === "completed" ? "Runtime cleanup is complete." : operation.status === "failed" ? "Cleanup will retry automatically. You can close this dialog while it continues." : "Cleanup is running in the background. You can close this dialog while it continues."}</p></div>;
}
