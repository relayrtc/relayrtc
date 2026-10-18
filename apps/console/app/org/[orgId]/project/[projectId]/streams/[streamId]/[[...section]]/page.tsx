import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema } from "@relayrtc/database";
import { getAuthRuntime } from "@/lib/auth-server";
import { requireProject } from "@/lib/console-data";
import { getStreamAction, listStreamsAction } from "@/actions/streaming";
import { getBroadcastAction, listBroadcastsAction } from "@/actions/broadcasts";
import { listRecordingsAction } from "@/actions/recordings";
import { listSchedulesAction } from "@/actions/schedules";
import { streamSections, streamWorkspaceHref } from "@/lib/stream-workspace";
import { StreamWorkspace } from "@/components/project/stream-workspace";
import { DvrManager } from "@/components/project/dvr-manager";
import { StreamOverview } from "@/components/project/stream-overview";
import { StreamSettings } from "@/components/project/stream-settings";
import { StreamGuests } from "@/components/project/stream-guests";
import { DestinationsManager } from "@/components/project/destinations-manager";
import { BroadcastsManager } from "@/components/project/broadcasts-manager";
import { ClipsManager } from "@/components/project/clips-manager";
import { RecordingsManager } from "@/components/project/recordings-manager";
import { SchedulesManager } from "@/components/project/schedules-manager";
import { MixerStudio } from "@/components/project/mixer-studio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stream workspace" };
export default async function StreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string; streamId: string; section?: string[] }>;
  searchParams: Promise<{ environmentId?: string; broadcastId?: string }>;
}) {
  const { orgId, projectId, streamId, section: segments } = await params;
  const query = await searchParams;
  const section = segments?.[0] ?? "overview";
  const task = segments?.[1];
  const taskSections = [
    "broadcasts",
    "destinations",
    "clips",
    "recordings",
    "schedule",
    "studio",
    "guests",
  ];
  if (
    (segments?.length ?? 0) > 2 ||
    !streamSections.some((s) => s.id === section) ||
    (task && (task !== "new" || !taskSections.includes(section)))
  )
    notFound();
  const data = await requireProject(orgId, projectId),
    projectBase = `/org/${orgId}/project/${projectId}`;
  if (task && !data.canManage) notFound();
  const [identity] = await getAuthRuntime()
    .database.select({ environmentId: schema.streamingStream.environmentId })
    .from(schema.streamingStream)
    .where(
      and(eq(schema.streamingStream.id, streamId), eq(schema.streamingStream.projectId, projectId)),
    );
  if (!identity) notFound();
  const environment = data.environments.find(
    (e) => e.id === identity.environmentId && e.status === "active",
  );
  if (!environment || (query.environmentId && query.environmentId !== environment.id)) notFound();
  if (!query.environmentId)
    redirect(
      streamWorkspaceHref(
        projectBase,
        streamId,
        environment.id,
        task ? `${section}/${task}` : section,
        query.broadcastId,
      ),
    );
  const scope = { projectId, environmentId: environment.id, streamId };
  const [detail, listed, current, explicit] = await Promise.all([
    getStreamAction(scope),
    listBroadcastsAction(scope),
    listBroadcastsAction({ ...scope, activeOnly: true }),
    query.broadcastId
      ? getBroadcastAction({ ...scope, broadcastId: query.broadcastId })
      : Promise.resolve(null),
  ]);
  if (explicit?.data && explicit.data.streamId !== streamId) notFound();
  if (detail.error || listed.error || current.error || explicit?.error)
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Stream workspace unavailable</h1>
        <p role="alert" className="text-sm text-destructive">
          {detail.error?.description ??
            listed.error?.description ??
            current.error?.description ??
            explicit?.error?.description}
        </p>
        <Link
          className="text-sm underline"
          href={`${projectBase}/streams?environmentId=${encodeURIComponent(environment.id)}`}
        >
          Back to streams
        </Link>
      </div>
    );
  if (!detail.data || !listed.data) notFound();
  const runs = listed.data.data;
  const selectedRun = explicit?.data ?? current.data?.data[0] ?? runs[0] ?? null;
  const common = {
    projectId,
    environmentId: environment.id,
    environments: [environment],
    canManage: data.canManage,
  };
  let content: React.ReactNode;
  switch (section) {
    case "overview":
      content = <StreamOverview />;
      break;
    case "dvr":
      content = <DvrManager {...scope} canManage={data.canManage} />;
      break;
    case "settings":
      content = <StreamSettings />;
      break;
    case "guests":
      content = <StreamGuests />;
      break;
    case "destinations":
      content = <DestinationsManager {...scope} canManage={data.canManage} />;
      break;
    case "broadcasts":
      content = (
        <BroadcastsManager
          {...common}
          initialRows={runs}
          initialCursor={listed.data.nextCursor}
          initialError={null}
          initialLimits={listed.data.limits}
        />
      );
      break;
    case "clips":
      content = <ClipsManager {...common} streams={[detail.data]} />;
      break;
    case "recordings": {
      const result = await listRecordingsAction(scope);
      content = (
        <RecordingsManager
          {...common}
          initialRows={result.data?.data ?? []}
          initialCursor={result.data?.nextCursor ?? null}
          initialError={result.error?.description ?? null}
        />
      );
      break;
    }
    case "schedule": {
      const result = await listSchedulesAction(scope);
      content = (
        <SchedulesManager
          {...common}
          initialRows={result.data?.data ?? []}
          initialCursor={result.data?.nextCursor ?? null}
          initialError={result.error?.description ?? null}
          initialLimits={result.data?.limits ?? null}
        />
      );
      break;
    }
    case "studio": {
      const sources = await listStreamsAction({ projectId, environmentId: environment.id });
      content = (
        <MixerStudio
          {...common}
          broadcasts={selectedRun ? [selectedRun] : []}
          streams={sources.data?.data ?? []}
          initialError={sources.error?.description ?? null}
        />
      );
      break;
    }
  }
  return (
    <StreamWorkspace
      key={`${streamId}:${section === "settings" ? detail.data.version : "view"}:${section === "overview" ? "overview" : (query.broadcastId ?? "automatic")}:${section}`}
      initialStream={detail.data}
      initialRuns={[
        ...new Map([...(current.data?.data ?? []), ...runs].map((r) => [r.id, r])).values(),
      ]}
      selectedRun={selectedRun}
      projectBase={projectBase}
      environmentName={environment.name}
      canManage={data.canManage}
    >
      {content}
    </StreamWorkspace>
  );
}
