"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Radio, RefreshCw, ArrowRight } from "lucide-react";
import { listStreamsAction } from "@/actions/streaming";
import { PageHeader } from "@/components/page/page-header";
import { SimpleSelect } from "@/components/page/simple-select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StreamForm } from "./stream-form";
import { streamWorkspaceHref } from "@/lib/stream-workspace";
import type { ConsoleEnvironment } from "@/lib/console-types";
import type { ConsoleStream } from "@/lib/streaming/contracts";
export function StreamsManager({
  projectId,
  environmentId,
  environments,
  canManage,
  initialRows,
  initialCursor,
  initialError,
}: {
  projectId: string;
  environmentId: string;
  environments: readonly ConsoleEnvironment[];
  canManage: boolean;
  initialRows: ConsoleStream[];
  initialCursor: string | null;
  initialError: string | null;
}) {
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const base = pathname.slice(0, pathname.lastIndexOf("/streams"));
  const [rows, setRows] = useState(initialRows),
    [cursor, setCursor] = useState(initialCursor),
    [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false),
    [creating, setCreating] = useState(false),
    [filter, setFilter] = useState("");
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );
  const load = useCallback(
    async (next?: string) => {
      const current = ++revision.current;
      setPending(true);
      try {
        const result = await listStreamsAction({
          projectId,
          environmentId,
          ...(next ? { cursor: next } : {}),
        });
        if (current !== revision.current) return;
        if (result.error) setError(result.error.description);
        else {
          setRows((previous) =>
            next
              ? [...new Map([...previous, ...result.data.data].map((s) => [s.id, s])).values()]
              : result.data.data,
          );
          setCursor(result.data.nextCursor);
          setError(null);
        }
      } catch {
        if (current === revision.current) setError("Streams are unavailable. Try again.");
      } finally {
        if (current === revision.current) setPending(false);
      }
    },
    [projectId, environmentId],
  );
  const visible = rows.filter((s) =>
    `${s.name} ${s.id} ${s.source.kind}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Streams"
        description="Open a stream to manage its preview, broadcasts, guests and media."
        actions={
          canManage && (
            <Button disabled={!environmentId} onClick={() => setCreating(true)}>
              <Plus />
              Create stream
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <SimpleSelect
          aria-label="Environment"
          value={environmentId}
          options={environments.map((e) => ({ value: e.id, label: e.name }))}
          onValueChange={(value) => {
            const query = new URLSearchParams(search);
            query.set("environmentId", value);
            document.cookie = `relayrtc.environment.${projectId}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=31536000`;
            router.push(`${pathname}?${query}`);
          }}
        />
        <Input
          className="max-w-sm"
          aria-label="Filter streams"
          placeholder="Filter streams by name or source"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button variant="outline" disabled={pending || !environmentId} onClick={() => void load()}>
          <RefreshCw className={pending ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="rounded-xl border">
        <Table aria-label="Streams">
          <TableHeader>
            <TableRow>
              <TableHead>Stream</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Workspace</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((stream) => {
              const href = streamWorkspaceHref(base, stream.id, environmentId);
              return (
                <TableRow key={stream.id}>
                  <TableCell>
                    <Link
                      href={href}
                      className="inline-flex items-center gap-2 font-medium hover:underline"
                    >
                      <Radio className="size-4 text-muted-foreground" />
                      {stream.name}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">{stream.id}</p>
                  </TableCell>
                  <TableCell>{stream.source.kind.toUpperCase()}</TableCell>
                  <TableCell>
                    {stream.profile.audioOnly
                      ? "Audio only"
                      : `${stream.profile.width} x ${stream.profile.height}`}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {stream.status === "active" ? "Configured" : stream.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={href}
                      className="inline-flex items-center gap-2 text-sm font-medium hover:underline"
                    >
                      Open stream
                      <ArrowRight className="size-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
            {!visible.length && (
              <TableRow>
                <TableCell colSpan={5} className="h-36 text-center text-muted-foreground">
                  {!environmentId
                    ? "Create an environment to get started."
                    : pending
                      ? "Loading streams..."
                      : filter
                        ? "No loaded streams match your search."
                        : "Create your first stream to connect an encoder or RTC room."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {cursor && (
        <Button variant="outline" disabled={pending} onClick={() => void load(cursor)}>
          Load more streams
        </Button>
      )}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Create stream</SheetTitle>
            <SheetDescription>
              Choose an encoder source or an existing RTC room. You can configure destinations and
              playback in the stream workspace.
            </SheetDescription>
          </SheetHeader>
          {creating && (
            <StreamForm
              stream={null}
              projectId={projectId}
              environmentId={environmentId}
              onSaved={(stream) => {
                setCreating(false);
                router.push(streamWorkspaceHref(base, stream.id, environmentId));
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
