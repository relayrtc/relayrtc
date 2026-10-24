import { notFound } from "next/navigation";
import { DeletionProgress } from "@/components/deletion-progress";

export const metadata = { title: "Deletion progress" };

export default async function Page({ params }: { params: Promise<{ kind: string; resourceId: string }> }) {
  const { kind, resourceId } = await params;
  if (kind !== "organization" && kind !== "project" && kind !== "environment") notFound();
  return <DeletionProgress key={`${kind}:${resourceId}`} kind={kind} resourceId={resourceId} />;
}
