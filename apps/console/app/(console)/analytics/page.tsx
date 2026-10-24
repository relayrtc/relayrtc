import type { Metadata } from "next";
import { Analytics } from "@/components/analytics";

export const metadata: Metadata = { title: "Analytics" };
export default function AnalyticsPage() { return <Analytics />; }
