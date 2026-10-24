import type { Metadata } from "next";
import { DeveloperApiKeys } from "@/components/developer-api-keys";
export const metadata: Metadata = { title: "API keys" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <DeveloperApiKeys key={id} projectId={id} />; }
