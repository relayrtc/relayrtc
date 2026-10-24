import type { AnalyticsRange, UsageRange, ReportWindow, ActivityView } from "./reporting-types";

export const analyticsRanges: { value: AnalyticsRange; label: string }[] = [{ value: "live", label: "Live" }, { value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }];
export const usageRanges: { value: UsageRange; label: string }[] = [{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "14d", label: "14 days" }, { value: "30d", label: "30 days" }];
export function projectReportPath(projectId: string, resource: "analytics" | "usage", range: string, environment = "all") {
  const query = new URLSearchParams({ range }); if (environment !== "all") query.set("environmentId", environment);
  return `/api/reporting/projects/${encodeURIComponent(projectId)}/${resource}?${query}`;
}
export function organizationReportPath(id: string, range: UsageRange, page = 0) { return `/api/reporting/organizations/${encodeURIComponent(id)}/usage?${new URLSearchParams({ range, limit: "30", offset: String(page * 30) })}`; }
export const activityPath = (projectId: string, environmentId: string) => `/api/account/activity/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(environmentId)}`;
export const activityHref = (projectId: string, environmentId: string, view: ActivityView, id: string) => `/activity/${view}/${encodeURIComponent(id)}?${new URLSearchParams({ projectId, environmentId })}`;
export const reportTimestamp = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
export const reportPeriod = (window: Pick<ReportWindow, "startedAt" | "endedAt">) => `${reportTimestamp(window.startedAt)} – ${reportTimestamp(window.endedAt)} UTC`;
export const chartLabel = (value: string, range: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...(range === "24h" || range === "live" ? { hour: "2-digit", minute: "2-digit", hour12: false } as const : { month: "short", day: "numeric" } as const) }).format(new Date(value));
// Protect spreadsheet exports from formula interpretation in resource names.
export function reportingCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const cell = (value: string | number | boolean | null | undefined) => {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n");
}
