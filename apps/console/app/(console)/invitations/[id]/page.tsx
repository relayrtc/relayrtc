import type { Metadata } from "next";
import { InvitationResponse } from "@/components/invitation-response";
export const metadata: Metadata = { title: "Organization Invitation" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <InvitationResponse key={id} id={id} />; }
