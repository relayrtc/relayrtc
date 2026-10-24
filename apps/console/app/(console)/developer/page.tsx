import type { Metadata } from "next";
import { ActiveDeveloperControls } from "@/components/developer-controls";
export const metadata: Metadata = { title: "Developer Controls" };
export default function Page() { return <ActiveDeveloperControls />; }
