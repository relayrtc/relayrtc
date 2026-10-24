import type { Metadata } from "next";
import { OrganizationMembers } from "@/components/organization-members";
export const metadata: Metadata = { title: "Team Members" };
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }> }) {
  const { id } = await params; const view = (await searchParams).view === "invitations" ? "invitations" : "members";
  return <OrganizationMembers key={`${id}:${view}`} id={id} initialView={view} />;
}
