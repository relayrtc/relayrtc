"use client";
import { useEffect, useState } from "react";
import { listStreamsAction } from "@/actions/streaming";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
export function StreamChoice({
  projectId,
  environmentId,
  value,
  onChange,
}: {
  projectId: string;
  environmentId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [rows, setRows] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      const items: { id: string; name: string }[] = [];
      let cursor: string | undefined;
      try {
        do {
          const result = await listStreamsAction({
            projectId,
            environmentId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          if (!active) return;
          if (result.error) throw new Error(result.error.description);
          items.push(...result.data.data.filter((s) => s.status === "active"));
          cursor = result.data.nextCursor ?? undefined;
        } while (cursor);
        if (active) setRows(items);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Streams could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [projectId, environmentId, retry]);
  return (
    <div className="space-y-2">
      <SimpleSelect
        name="streamId"
        aria-label="Stream"
        required
        disabled={loading}
        placeholder={loading ? "Loading streams…" : "Choose a stream"}
        value={value}
        onValueChange={onChange}
        options={rows.map((s) => ({ value: s.id, label: s.name }))}
      />
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button type="button" variant="outline" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && !rows.length && (
        <p className="text-sm text-muted-foreground">Create a stream in this environment first.</p>
      )}
    </div>
  );
}
