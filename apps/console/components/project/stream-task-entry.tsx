import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requireProject } from "@/lib/console-data";
import { ChooseStreamPage } from "./choose-stream-page";
export async function StreamTaskEntry({
  params,
  searchParams,
  section,
  title,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<{ environmentId?: string }>;
  section: string;
  title: string;
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
    <ChooseStreamPage
      projectId={projectId}
      environmentId={environment.id}
      base={`/org/${orgId}/project/${projectId}`}
      section={section}
      title={title}
    />
  );
}
