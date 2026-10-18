import { StreamTaskEntry } from "@/components/project/stream-task-entry";
export const dynamic = "force-dynamic";
export const metadata = { title: "Create a broadcast" };
export default function Page(props: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<{ environmentId?: string }>;
}) {
  return <StreamTaskEntry {...props} section="broadcasts" title="Create a broadcast" />;
}
