import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listRoomsAction } from "@/actions/rooms";
import { RoomsManager } from "@/components/project/rooms-manager";
import { requireProject } from "@/lib/console-data";

export const metadata: Metadata = {
  title: "Rooms",
  description: "Create and inspect real-time rooms.",
};
export const dynamic = "force-dynamic";

export default async function RoomsPage({
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
  const result = selected ? await listRoomsAction({ projectId, environmentId: selected.id }) : null;
  return (
    <RoomsManager
      key={selected?.id ?? "empty"}
      projectId={projectId}
      environmentId={selected?.id ?? ""}
      environments={environments}
      canManage={data.canManage}
      initialRows={result?.data?.rooms ?? []}
      initialCursor={result?.data?.nextCursor ?? null}
      initialError={result?.error?.description ?? null}
    />
  );
}
