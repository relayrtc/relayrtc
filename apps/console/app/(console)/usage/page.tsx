import type { Metadata } from "next";
import { Usage } from "@/components/usage";

export const metadata: Metadata = { title: "Usage" };
export default function UsagePage() { return <Usage />; }
