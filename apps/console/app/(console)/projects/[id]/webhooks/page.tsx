import type { Metadata } from "next";
import { DeveloperWebhooks } from "@/components/developer-webhooks";
export const metadata: Metadata = { title: "Webhooks" };
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ environment?: string | string[] }> }) { const { id } = await params; const { environment } = await searchParams; return <DeveloperWebhooks key={`${id}:${typeof environment === "string" ? environment : ""}`} projectId={id} initialEnvironmentId={typeof environment === "string" ? environment : undefined} />; }
