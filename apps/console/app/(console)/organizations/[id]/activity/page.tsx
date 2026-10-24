import type { Metadata } from "next";
import { AccountActivity } from "@/components/account-activity";
export const metadata: Metadata = { title: "Organization Activity" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <AccountActivity key={id} organizationId={id} />; }
