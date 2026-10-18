import type { ReactNode } from "react";

/** Shared table surface for streaming lists, matching the console's card surfaces. */
export function StreamTable({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card/30 px-4 sm:px-5 [&_table]:min-w-[32rem] [&_th]:h-12 [&_th]:px-2 [&_th]:text-xs [&_th]:font-normal [&_td]:px-2 [&_td]:py-4 [&_td]:text-sm [&_button]:rounded-lg [&_td[colspan]]:whitespace-normal [&_td[colspan]]:py-12 [&_td[colspan]]:text-center">
      {children}
    </div>
  );
}
