import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requireProject } from "@/lib/console-data";
import { CreateStreamPage } from "@/components/project/create-stream-page";
export const metadata = { title: "Create a stream" };
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<{ environmentId?: string }>;
}) {
  const { orgId, projectId } = await params;
  const query = await searchParams;
  const data = await requireProject(orgId, projectId);
  if (!data.canManage) notFound();
  const environments = data.environments.filter((e) => e.status === "active");
  const remembered = (await cookies()).get(`relayrtc.environment.${projectId}`)?.value;
  const environment = query.environmentId
    ? environments.find((e) => e.id === query.environmentId)
    : (environments.find((e) => e.id === remembered) ??
      environments.find((e) => e.type === "development") ??
      environments[0]);
  if (!environment) notFound();
  return (
    <CreateStreamPage
      projectId={projectId}
      environmentId={environment.id}
      environmentName={environment.name}
      base={`/org/${orgId}/project/${projectId}`}
    />
  );
}
