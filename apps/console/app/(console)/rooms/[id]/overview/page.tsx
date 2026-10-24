import type { Metadata } from "next";
import { RoomOverview } from "@/components/room-overview";

export const metadata: Metadata = { title: "Room Overview" };
export default async function RoomOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoomOverview key={id} roomId={id} />;
}
