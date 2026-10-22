import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/page/page-header";
import { Panel } from "@/components/page/panel";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ActivityRefresh } from "@/components/project/activity-refresh";
import {
  ActivityTabs,
  ActivityStatus,
  ResourceIdentity,
  ActivityPagination,
  activityDate,
} from "@/components/project/activity-view";
import { activityContext, activityViews, listActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Activity",
  description: "Inspect rooms, streams and media assets.",
};
const querySchema = z.object({
  view: z.enum(activityViews).default("rooms"),
  environmentId: z.string().min(1).max(128).optional(),
  page: z.coerce.number().int().min(0).max(1000).default(0),
  search: z.string().max(100).default(""),
  kind: z.enum(["all", "recording", "clip", "buffer"]).default("all"),
});

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, projectId } = await params;
  const parsed = querySchema.safeParse(await searchParams);
  if (!parsed.success) notFound();
  const query = parsed.data;
  const context = await activityContext(orgId, projectId, query.environmentId);
  const { rows, hasNext } = await listActivity(context, query.view, query.page, query.search, query.kind);
  const projectBase = `/org/${orgId}/project/${projectId}`;
  const isMedia = query.view === "assets";
  const base = `${projectBase}/${isMedia ? "media" : "realtime"}`;
  const environmentId = context.environment?.id;
  const href = (page: number) =>
    `${base}?${new URLSearchParams({ view: query.view, kind: query.kind, search: query.search, page: String(page), ...(environmentId ? { environmentId } : {}) })}`;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={isMedia ? "Media" : "Realtime"}
        description={isMedia ? "Recordings, clips and shared DVR buffers. Inspect assets and preview ready recordings." : "Rooms, livestreams and external sources. Explore sessions, connections and output health."}
        actions={<ActivityRefresh />}
      />
      {isMedia ? (
        <nav aria-label="Media type" className="flex gap-5 overflow-x-auto border-b">
          {[["all", "All media"], ["recording", "Recordings"], ["clip", "Clips"], ["buffer", "DVR buffers"]].map(([kind, label]) => (
            <Link key={kind} href={`${base}?${new URLSearchParams({ kind: kind!, ...(environmentId ? { environmentId } : {}) })}`} aria-current={query.kind === kind ? "page" : undefined} className={`shrink-0 border-b-2 pb-3 text-sm ${query.kind === kind ? "border-foreground font-medium" : "border-transparent text-muted-foreground"}`}>{label}</Link>
          ))}
        </nav>
      ) : <ActivityTabs base={base} view={query.view} {...(environmentId ? { environmentId } : {})} />}
      <form action={base} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value={query.view} />
        <input type="hidden" name="kind" value={query.kind} />
        <label className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
          Environment
          <select
            name="environmentId"
            defaultValue={environmentId}
            key={environmentId}
            disabled={!environmentId}
            className="h-9 max-w-full rounded-md border bg-background px-3 text-sm text-foreground"
          >
            {!environmentId && <option>No active environments</option>}
            {context.environments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-2 text-xs text-muted-foreground">
          Search
          <Input
            name="search"
            defaultValue={query.search}
            key={query.search}
            maxLength={100}
            placeholder="Name or resource ID"
          />
        </label>
        <Button variant="outline" type="submit" disabled={!environmentId}>
          Apply
        </Button>
      </form>
      <Panel>
        {rows.length ? (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    className="block break-all text-sm font-medium hover:underline"
                    href={`${projectBase}/activity/${query.view}/${encodeURIComponent(row.id)}?environmentId=${encodeURIComponent(environmentId!)}`}
                  >
                    {query.view === "assets" ? (row.detail === "buffer" ? "DVR buffer" : row.detail === "clip" ? "Clip" : "Recording") : row.label}
                  </Link>
                  {(query.view === "assets" || row.label !== row.id) && <ResourceIdentity id={row.id} />}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.detail.replaceAll("_", " ")} · {activityDate(row.createdAt)}
                  </p>
                </div>
                <ActivityStatus value={row.status} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="py-10 text-center">
            <h2 className="text-sm font-medium">
              {!environmentId
                ? "No active environments"
                : query.search
                  ? "No matching resources"
                  : "No activity yet"}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {!environmentId
                ? "Create an environment in Settings to get started."
                : "Resources created through your SDK or API integration will appear here."}
            </p>
            <Link
              href="https://docs.relayrtc.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block text-sm underline"
            >
              View integration guides
            </Link>
          </div>
        )}
      </Panel>
      <ActivityPagination page={query.page} hasNext={hasNext && query.page < 1000} href={href} />
      <p className="text-xs text-muted-foreground">
        Refreshes every 15 seconds. Viewing this page does not join rooms, start streams or play
        media.
      </p>
    </div>
  );
}
