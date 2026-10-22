import { redirect } from "next/navigation";
import { requireProject } from "@/lib/console-data";
export default async function LegacyStreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string; streamId: string }>;
  searchParams: Promise<{ environmentId?: string }>;
}) {
  const { orgId, projectId, streamId } = await params;
  const { environmentId } = await searchParams;
  await requireProject(orgId, projectId);
  redirect(
    `/org/${orgId}/project/${projectId}/activity/streams/${encodeURIComponent(streamId)}${environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : ""}`,
  );
}
