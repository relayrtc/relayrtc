import type { Metadata } from "next";
import { AuthFlow, type AuthParams } from "@/components/auth-flow";

export const metadata: Metadata = { title: { absolute: "Verify email · Relayrtc" } };
export default async function Page({ searchParams }: { searchParams: Promise<AuthParams> }) {
  return <AuthFlow mode="verify-email" params={await searchParams} />;
}
