import type { Metadata } from "next";
import { RoomsList } from "@/components/rooms-list";

export const metadata: Metadata = { title: "Rooms" };
export default function RoomsPage() { return <RoomsList />; }
