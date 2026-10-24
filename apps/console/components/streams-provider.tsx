"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { streamingPath, streamCommand } from "@/lib/stream-api";
import { validateStream } from "@/lib/streams";
import type { Stream, StreamInput } from "@/lib/stream-types";
import { useRooms } from "./rooms-provider";
import { useWorkspace } from "./workspace-provider";

type StreamsContext = {
  scope: string; ready: boolean; error: string; canManage: boolean;
  projectId: string | null; environmentId: string;
  path: (path: string, query?: Record<string, string>) => string;
  addStream: (input: StreamInput) => Promise<Stream>;
};
const Context = createContext<StreamsContext | null>(null);

export function StreamsProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const rooms = useRooms();
  const projectId = workspace.ready && !workspace.pending ? workspace.activeProjectId : null;
  const environmentId = rooms.environmentId;
  const ready = Boolean(projectId && rooms.projectId === projectId && environmentId && rooms.environments.length);
  // Match the streaming service's management policy. Room operators may have
  // broader rights; the streaming API remains authoritative for every request.
  const canManage = workspace.organization?.role === "owner" || workspace.organization?.role === "admin";
  const path = useCallback((resource: string, query: Record<string, string> = {}) => streamingPath(projectId ?? "", environmentId, resource, query), [projectId, environmentId]);
  const addStream = useCallback(async (input: StreamInput) => {
    if (!ready) throw new Error("Your project is still loading.");
    if (!canManage) throw new Error("Only organization owners and admins can manage streams.");
    const invalid = validateStream(input); if (invalid) throw new Error(invalid);
    return streamCommand<Stream>(path("streams"), { ...input, name: input.name.trim() });
  }, [ready, canManage, path]);
  const value = useMemo(() => ({ scope: `${projectId ?? ""}:${environmentId}`, ready, error: rooms.error, canManage, projectId, environmentId, path, addStream }), [projectId, environmentId, ready, rooms.error, canManage, path, addStream]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useStreams() {
  const context = useContext(Context);
  if (!context) throw new Error("useStreams must be used within StreamsProvider");
  return context;
}
