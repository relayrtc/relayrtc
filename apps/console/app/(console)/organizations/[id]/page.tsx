import type { Metadata } from "next";
import { OrganizationSettings } from "@/components/organization-settings";
export const metadata: Metadata = { title: "Organization" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <OrganizationSettings key={id} id={id} />; }
