import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActivityInspectionView } from "@/components/activity-inspection";
import type { ActivityView } from "@/lib/reporting-types";
export const metadata: Metadata = { title: "Activity details" };
export default async function ActivityDetailPage({ params, searchParams }: { params: Promise<{ view: string; id: string }>; searchParams: Promise<{ projectId?: string | string[]; environmentId?: string | string[] }> }) {
  const { view, id } = await params, query = await searchParams;
  if (!["rooms", "streams", "assets", "sources"].includes(view) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) notFound();
  if ((query.projectId && (typeof query.projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(query.projectId))) || (query.environmentId && (typeof query.environmentId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(query.environmentId)))) notFound();
  return <ActivityInspectionView view={view as ActivityView} resourceId={id} projectId={typeof query.projectId === "string" ? query.projectId : undefined} environmentId={typeof query.environmentId === "string" ? query.environmentId : undefined} />;
}
