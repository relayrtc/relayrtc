import { LoadingSkeleton } from "@/ui/skeleton";

export default function Loading() {
  return <main className="login-page" id="main-content"><section className="login-center"><LoadingSkeleton rows={3} label="Loading sign-in" /></section></main>;
}
