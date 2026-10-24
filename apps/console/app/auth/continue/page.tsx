import { redirect } from "next/navigation";
import { getServerAccount } from "@/lib/auth-server";
import { authHref, authSearchParams, postAuthDestination } from "@/lib/auth-query";
import { AuthFrame } from "@/ui/auth-frame";
import type { AuthParams } from "@/components/auth-flow";

export default async function ContinuePage({ searchParams }: { searchParams: Promise<AuthParams> }) {
  const params = await searchParams;
  const destination = postAuthDestination(authSearchParams(params));
  let account;
  try { account = await getServerAccount(); }
  catch { return <AuthFrame title="Unable to finish signing in" description="Account services are temporarily unavailable."><div className="login-form auth-form"><a href="" className="button button-primary onboarding-continue">Try again</a></div></AuthFrame>; }
  redirect(account ? destination : authHref("/auth/login", destination));
}
