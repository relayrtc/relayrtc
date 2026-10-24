import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerAccount } from "@/lib/auth-server";
import { authSearchParams, postAuthDestination } from "@/lib/auth-query";
import { AuthFlow, type AuthParams } from "@/components/auth-flow";

export const metadata: Metadata = { title: { absolute: "Create an account · Relayrtc" } };
export default async function Page({ searchParams }: { searchParams: Promise<AuthParams> }) {
  const params = await searchParams;
  let account = null;
  try { account = await getServerAccount(); } catch { /* Keep signup available during a service outage. */ }
  if (account) redirect(postAuthDestination(authSearchParams(params)));
  return <AuthFlow mode="signup" params={params} />;
}
