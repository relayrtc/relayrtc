import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { authHref } from "@/lib/auth-query";
import { getServerAccount } from "@/lib/auth-server";
import { AccountProvider } from "@/components/account-provider";
import { AppShell } from "@/components/app-shell";
import { WorkspaceProvider } from "@/components/workspace-provider";
import { RoomsProvider } from "@/components/rooms-provider";
import { StreamsProvider } from "@/components/streams-provider";
import { AuthFrame } from "@/ui/auth-frame";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  let account;
  try { account = await getServerAccount(); }
  catch {
    return <AuthFrame title="Account services unavailable" description="We couldn’t connect to Relayrtc. Please try again in a moment."><div className="login-form auth-form"><a className="button button-primary onboarding-continue" href="">Try again</a><a className="auth-text-button" href="/auth/login">Back to login</a></div></AuthFrame>;
  }
  if (!account) redirect(authHref("/auth/login", (await headers()).get("x-relayrtc-path") ?? "/rooms"));
  return <AccountProvider key={account.user.id} initialAccount={account}><WorkspaceProvider key={account.user.id}><RoomsProvider><StreamsProvider><AppShell>{children}</AppShell></StreamsProvider></RoomsProvider></WorkspaceProvider></AccountProvider>;
}
