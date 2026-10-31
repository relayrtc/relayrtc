import type { Metadata } from "next";
import { RoomManagementPage } from "@/components/room-management-page";

export const metadata: Metadata = { title: "Room Audit Log" };

export default async function RoomAuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoomManagementPage key={id} roomId={id} view="audit" />;
}
