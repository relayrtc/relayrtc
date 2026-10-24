import { notFound } from "next/navigation";
import { LegacyConsoleRedirect } from "@/components/legacy-console-redirect";
import { legacyConsoleDestination } from "@/lib/legacy-console";

export const metadata = { title: "Opening workspace" };

export default async function Page({ params, searchParams }: {
  params: Promise<{ orgId: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orgId, path }, search] = await Promise.all([params, searchParams]);
  const destination = legacyConsoleDestination(orgId, path, search);
  if (!destination) notFound();
  return <LegacyConsoleRedirect key={`${orgId}:${destination.projectId ?? ""}:${destination.href}`} destination={destination} />;
}
