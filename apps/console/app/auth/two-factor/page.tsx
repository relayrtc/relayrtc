import type { Metadata } from "next";
import { AuthFlow, type AuthParams } from "@/components/auth-flow";

export const metadata: Metadata = { title: { absolute: "Two-factor authentication · Relayrtc" } };
export default async function Page({ searchParams }: { searchParams: Promise<AuthParams> }) {
  return <AuthFlow mode="two-factor" params={await searchParams} />;
}
