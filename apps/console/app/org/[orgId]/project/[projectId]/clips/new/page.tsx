import { StreamTaskEntry } from "@/components/project/stream-task-entry";
export const dynamic = "force-dynamic";
export const metadata = { title: "Create a clip" };
export default function Page(props: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams: Promise<{ environmentId?: string }>;
}) {
  return <StreamTaskEntry {...props} section="clips" title="Create a clip" />;
}
