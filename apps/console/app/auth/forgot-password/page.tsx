import type { Metadata } from "next";
import { AuthFlow, type AuthParams } from "@/components/auth-flow";

export const metadata: Metadata = { title: { absolute: "Forgot password · Relayrtc" } };
export default async function Page({ searchParams }: { searchParams: Promise<AuthParams> }) {
  return <AuthFlow mode="forgot-password" params={await searchParams} />;
}
