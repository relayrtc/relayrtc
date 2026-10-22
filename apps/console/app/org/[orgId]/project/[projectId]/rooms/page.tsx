import { redirect } from "next/navigation";
import { requireProject } from "@/lib/console-data";
export default async function LegacyActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<{ environmentId?: string }>;
}) {
  const { orgId, projectId } = await params;
  const { environmentId } = await searchParams;
  await requireProject(orgId, projectId);
  redirect(
    `/org/${orgId}/project/${projectId}/activity?${new URLSearchParams({ view: "rooms", ...(environmentId ? { environmentId } : {}) })}`,
  );
}
