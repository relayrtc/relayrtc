import { redirect } from "next/navigation";
import { roomOverviewPath } from "@/lib/rooms";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(roomOverviewPath(id));
}
