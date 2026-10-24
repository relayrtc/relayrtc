import type { Metadata } from "next";
import { ProjectsList } from "@/components/workspaces-list";
export const metadata: Metadata = { title: "Projects" };
export default function Page() { return <ProjectsList />; }
