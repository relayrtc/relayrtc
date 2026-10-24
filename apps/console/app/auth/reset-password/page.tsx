import type { Metadata } from "next";
import { AuthFlow, type AuthParams } from "@/components/auth-flow";

export const metadata: Metadata = { title: { absolute: "Reset password · Relayrtc" } };
export default async function Page({ searchParams }: { searchParams: Promise<AuthParams> }) {
  return <AuthFlow mode="reset-password" params={await searchParams} />;
}
