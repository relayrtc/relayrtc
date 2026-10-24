import type { Metadata } from "next";
import { StreamOverview } from "@/components/stream-overview";

export const metadata: Metadata = { title: "Stream Overview" };
export default async function StreamOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StreamOverview streamId={id} />;
}
