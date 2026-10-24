import type { Metadata } from "next";
import { ProjectSettings } from "@/components/project-settings";
export const metadata: Metadata = { title: "Project" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ProjectSettings key={id} id={id} />; }
