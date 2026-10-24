import { redirect } from "next/navigation";
import { authSearchParams } from "@/lib/auth-query";
import type { AuthParams } from "@/components/auth-flow";
export default async function Page({ searchParams }: { searchParams: Promise<AuthParams> }) { redirect(`/auth/signup?${authSearchParams(await searchParams)}`); }
