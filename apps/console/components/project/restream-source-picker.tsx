"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { commandRestreamSourceAction, listRestreamSourcesAction } from "@/actions/restream";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
import type { ConsoleRestreamSource } from "@/lib/streaming/restream-contracts";
export function RestreamSourcePicker({
  projectId,
  environmentId,
  streamId,
  canManage,
}: {
  projectId: string;
  environmentId: string;
  streamId: string;
  canManage: boolean;
}) {
  const [sources, setSources] = useState<ConsoleRestreamSource[]>([]),
    [selected, setSelected] = useState(""),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    keys = useRef(new Map<string, string>()),
    pathname = usePathname();
  useEffect(() => {
    let active = true;
    void listRestreamSourcesAction({ projectId, environmentId })
      .then((result) => {
        if (!active) return;
        if (result.error) setError(result.error.description);
        else setSources(result.data.data.filter((s) => s.streamId === streamId));
      })
      .catch(() => {
        if (active) setError("Source status is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [projectId, environmentId, streamId]);
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Registered external source</p>
      {sources.length > 0 && (
        <SimpleSelect
          aria-label="Registered external source"
          value={selected}
          onValueChange={(value) => {
            if (!pending) setSelected(value);
          }}
          placeholder="Select a source"
          options={sources.map((s) => ({ value: s.id, label: `${s.name} · ${s.protocol}` }))}
        />
      )}
      <Link
        className="text-sm underline"
        href={`${pathname.split("/streams")[0]}/sources?environmentId=${encodeURIComponent(environmentId)}`}
      >
        Manage sources
      </Link>
      {canManage && selected && (
        <div className="flex gap-2">
          {(["probe", "start", "stop"] as const).map((command) => (
            <Button
              key={command}
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                const cacheKey = `${selected}:${command}`,
                  idempotencyKey = keys.current.get(cacheKey) ?? crypto.randomUUID();
                keys.current.set(cacheKey, idempotencyKey);
                setPending(true);
                void commandRestreamSourceAction({
                  projectId,
                  environmentId,
                  sourceId: selected,
                  command,
                  idempotencyKey,
                })
                  .then((result) => {
                    if (result.error) setError(result.error.description);
                    else {
                      keys.current.delete(cacheKey);
                      setError(`Source ${result.data.state}.`);
                    }
                  })
                  .catch(() => setError("Command could not be confirmed. Retry."))
                  .finally(() => setPending(false));
              }}
            >
              {command[0]!.toUpperCase() + command.slice(1)}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="status" className="text-xs text-muted-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
