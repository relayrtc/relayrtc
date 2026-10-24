import type { Metadata } from "next";
import { DeveloperWebhookDetails } from "@/components/developer-webhooks";
export const metadata: Metadata = { title: "Webhook" };
export default async function Page({ params }: { params: Promise<{ id: string; environmentId: string; endpointId: string }> }) { const { id, environmentId, endpointId } = await params; return <DeveloperWebhookDetails key={`${id}:${environmentId}:${endpointId}`} projectId={id} environmentId={environmentId} endpointId={endpointId} />; }
