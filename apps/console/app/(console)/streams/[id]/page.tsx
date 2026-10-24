import { redirect } from "next/navigation";
import { streamOverviewPath } from "@/lib/streams";

export default async function StreamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(streamOverviewPath(id));
}
