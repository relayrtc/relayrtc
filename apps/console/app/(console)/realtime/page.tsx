import type { Metadata } from "next";
import { RoomsList } from "@/components/rooms-list";
export const metadata: Metadata = { title: "Realtime" };
export default function Page() { return <RoomsList realtime />; }
