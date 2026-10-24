import type { Metadata } from "next";
import { AccountActivity } from "@/components/account-activity";
export const metadata: Metadata = { title: "Security Activity" };
export default function Page() { return <AccountActivity />; }
