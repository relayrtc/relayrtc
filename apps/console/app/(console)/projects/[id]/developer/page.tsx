import type { Metadata } from "next";
import { DeveloperControls } from "@/components/developer-controls";
export const metadata: Metadata = { title: "Developer Controls" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <DeveloperControls key={id} projectId={id} />; }
