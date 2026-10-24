import type { Metadata } from "next";
import { OrganizationsList } from "@/components/workspaces-list";
export const metadata: Metadata = { title: "Organizations" };
export default function Page() { return <OrganizationsList />; }
