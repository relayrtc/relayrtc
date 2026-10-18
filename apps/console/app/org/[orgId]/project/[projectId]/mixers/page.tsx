import { redirect } from "next/navigation";
import { requireProject } from "@/lib/console-data";
import { streamWorkspaceHref } from "@/lib/stream-workspace";
export default async function LegacyStreamingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<{ environmentId?: string; streamId?: string; broadcastId?: string }>;
}) {
  const { orgId, projectId } = await params;
  const query = await searchParams;
  await requireProject(orgId, projectId);
  const base = `/org/${orgId}/project/${projectId}`;
  if (query.streamId)
    redirect(
      streamWorkspaceHref(
        base,
        query.streamId,
        query.environmentId ?? "",
        "studio",
        query.broadcastId,
      ),
    );
  redirect(
    `${base}/streams${query.environmentId ? `?environmentId=${encodeURIComponent(query.environmentId)}` : ""}`,
  );
}
