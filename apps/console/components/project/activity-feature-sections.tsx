import Link from "next/link";
import { ActivityError, ActivityFields, activityDate } from "@/components/project/activity-view";
import type { InspectionGroup } from "@/lib/activity-features";
export function ActivityFeatureSections({ groups, base, environmentId }: {
    groups: InspectionGroup[];
    base: string;
    environmentId: string;
}) {
    return <div className="space-y-3">{groups.map(group => <details key={group.title} className="rounded-xl border bg-background p-4">
   <summary className="cursor-pointer text-sm font-medium">{group.title}<span className="ml-2 text-xs font-normal text-muted-foreground">{group.rows.length}{group.hasNext ? "+" : ""} on this page</span></summary>
   <div className="mt-4 space-y-4">{!group.rows.length && <p className="text-sm text-muted-foreground">No records on this page.</p>}
   {group.rows.map((row, index) => <div key={index} className="rounded-lg border p-4"><ActivityFields fields={Object.entries(row).filter(([key]) => key !== "Error").map(([key, value]) => [key, value instanceof Date ? activityDate(value) : typeof value === "boolean" ? (value ? "Yes" : "No") : typeof value === "string" && ["Room ID", "Source stream ID", "Source recording ID", "Buffer recording ID"].includes(key) ? <Link className="break-all underline" href={`${base}/activity/${key === "Room ID" ? "rooms" : key === "Source stream ID" ? "streams" : "assets"}/${encodeURIComponent(value)}?environmentId=${encodeURIComponent(environmentId)}`}>{value}</Link> : value])}/><ActivityError value={typeof row.Error === "string" ? row.Error : null}/></div>)}
   {group.hasNext && <p className="text-xs text-muted-foreground">More records are available using Next below.</p>}
   </div>
 </details>)}</div>;
}
