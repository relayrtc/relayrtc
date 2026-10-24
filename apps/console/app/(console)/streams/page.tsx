import type { Metadata } from "next";
import { StreamsList } from "@/components/streams-list";

export const metadata: Metadata = { title: "Streams" };
export default function StreamsPage() { return <StreamsList />; }
