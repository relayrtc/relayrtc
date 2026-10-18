"use client";
import { Button } from "@/components/ui/button";
export default function StreamWorkspaceError({ reset }: { reset: () => void }) {
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Could not load this stream</h1>
      <p className="text-sm text-muted-foreground">
        Your changes may still have completed. Retry to check the current state.
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
