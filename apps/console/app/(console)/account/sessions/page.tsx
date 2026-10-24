import type { Metadata } from "next";
import { AccountSessions } from "@/components/account-sessions";
export const metadata: Metadata = { title: "Sessions" };
export default function Page() { return <AccountSessions />; }
