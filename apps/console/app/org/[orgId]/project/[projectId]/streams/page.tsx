import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireProject } from "@/lib/console-data";
import { StreamsManager } from "@/components/project/streams-manager";
import { listStreamsAction } from "@/actions/streaming";

export const metadata: Metadata = {
  title: "Streams",
  description: "Manage live sources and private playback.",
};
export const dynamic = "force-dynamic";

export default async function StreamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<{ environmentId?: string }>;
}) {
  const { orgId, projectId } = await params;
  const { environmentId } = await searchParams;
  const data = await requireProject(orgId, projectId);
  const environments = data.environments.filter((item) => item.status === "active");
  const selected = environmentId
    ? environments.find((item) => item.id === environmentId)
    : (environments.find((item) => item.type === "development") ?? environments[0]);
  if (environmentId && !selected) notFound();
  const result = selected
    ? await listStreamsAction({ projectId, environmentId: selected.id })
    : null;
  return (
    <StreamsManager
      key={selected?.id ?? "empty"}
      projectId={projectId}
      environmentId={selected?.id ?? ""}
      environments={environments}
      canManage={data.canManage}
      initialRows={result?.data?.data ?? []}
      initialCursor={result?.data?.nextCursor ?? null}
      initialError={result?.error?.description ?? null}
    />
  );
}
