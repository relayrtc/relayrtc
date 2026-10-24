import type { Metadata } from "next";
import { Onboarding, type OnboardingMode } from "@/components/onboarding";

export const metadata: Metadata = { title: { absolute: "Get started · Relayrtc" }, description: "Create your Relayrtc organization and project." };
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ new?: string; organizationId?: string; redirect?: string }> }) {
  const params = await searchParams;
  const mode: OnboardingMode = params.new === "organization" || params.new === "project" ? params.new : null;
  return <Onboarding mode={mode} organizationId={params.organizationId} destination={params.redirect} />;
}
