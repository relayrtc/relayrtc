"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { accountRequest } from "@/lib/account-api";
import { realtimeProjectPath, roomEnvironmentPath } from "@/lib/room-api";
import { validateRoom } from "@/lib/rooms";
import type { Room, RoomConnection, RoomContext } from "@/lib/room-types";
import type { ProjectEnvironment } from "@/lib/workspace-types";
import { useWorkspace } from "./workspace-provider";
import { useWorkspaceResource } from "./use-workspace-resource";

type RoomsContext = {
  rooms: Room[]; ready: boolean; error: string; canOperate: boolean; projectId: string | null;
  environments: ProjectEnvironment[]; environmentId: string; environment: ProjectEnvironment | undefined;
  setEnvironmentId: (id: string) => void; refresh: () => Promise<unknown>;
  roomsLoading: boolean; hasMoreRooms: boolean; loadMoreRooms: () => void;
  createRoom: (name: string, maxParticipants: number, metadata?: Record<string, unknown>) => Promise<Room>;
};
const Context = createContext<RoomsContext | null>(null);
type RoomOptionPages = { scope: string; cursor: string; pages: Record<string, Room[]> };
const emptyOptions: RoomOptionPages = { scope: "", cursor: "", pages: {} };

export function RoomsProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const projectId = workspace.ready && !workspace.pending ? workspace.activeProjectId : null;
  const resource = useWorkspaceResource<RoomContext>(projectId ? realtimeProjectPath(projectId) : null);
  const [selection, setSelection] = useState({ projectId: "", environmentId: "" });
  const environments = useMemo(() => resource.data?.environments ?? [], [resource.data]);
  const environment = environments.find(item => selection.projectId === projectId && item.id === selection.environmentId)
    ?? environments.find(item => item.type === "development") ?? environments[0];
  const environmentId = environment?.id ?? "";
  const metadataReady = Boolean(projectId && resource.data?.project.id === projectId);
  // Room streaming shares the selected environment and uses real joinable rooms.
  const needsOptions = pathname.startsWith("/streams");
  const optionsScope = `${projectId ?? ""}:${environmentId}`;
  const [optionPages, setOptionPages] = useState<RoomOptionPages>(emptyOptions);
  const currentOptions = optionPages.scope === optionsScope ? optionPages : emptyOptions;
  const optionQuery = new URLSearchParams({ limit: "100", joinable: "true", ...(currentOptions.cursor ? { cursor: currentOptions.cursor } : {}) });
  const options = useWorkspaceResource<RoomConnection>(needsOptions && metadataReady && projectId && environmentId
    ? `${roomEnvironmentPath(projectId, environmentId)}/rooms?${optionQuery}` : null);
  useEffect(() => {
    const data = options.data;
    if (!needsOptions || !data) return;
    setOptionPages(current => ({ scope: optionsScope, cursor: currentOptions.cursor,
      pages: { ...(current.scope === optionsScope ? current.pages : {}), [currentOptions.cursor]: data.nodes } }));
  }, [needsOptions, options.data, optionsScope, currentOptions.cursor]);
  const ready = metadataReady && (!needsOptions || Boolean(options.data) || Object.keys(currentOptions.pages).length > 0);
  const canOperate = Boolean(metadataReady && resource.data?.canOperate);
  const setEnvironmentId = useCallback((id: string) => {
    if (projectId && environments.some(item => item.id === id)) setSelection({ projectId, environmentId: id });
  }, [projectId, environments]);
  const createRoom = useCallback(async (name: string, maxParticipants: number, metadata: Record<string, unknown> = {}) => {
    if (!projectId || !environmentId || !metadataReady) throw new Error("Your project is still loading.");
    if (!canOperate) throw new Error("Your role cannot create rooms.");
    const error = validateRoom(name, maxParticipants); if (error) throw new Error(error);
    return accountRequest<Room>(`${roomEnvironmentPath(projectId, environmentId)}/rooms`, { name: name.trim(), maxParticipants, metadata });
  }, [projectId, environmentId, metadataReady, canOperate]);
  const rooms = useMemo(() => {
    const all = [...Object.values(currentOptions.pages).flat(), ...(options.data?.nodes ?? [])];
    return [...new Map(all.map(room => [room.id, room])).values()].filter(room => room.status === "created" || room.status === "active");
  }, [currentOptions.pages, options.data]);
  const loadMoreRooms = useCallback(() => {
    const data = options.data;
    if (!data?.pageInfo.endCursor || options.loading) return;
    setOptionPages(current => ({ scope: optionsScope, cursor: data.pageInfo.endCursor!,
      pages: { ...(current.scope === optionsScope ? current.pages : {}), [currentOptions.cursor]: data.nodes } }));
  }, [options.data, options.loading, optionsScope, currentOptions.cursor]);
  const refresh = useCallback(() => Promise.all([resource.refresh(), ...(needsOptions ? [options.refresh()] : [])]), [resource.refresh, options.refresh, needsOptions]);
  const value = useMemo(() => ({ rooms, ready, canOperate, projectId, environments, environmentId, environment,
    error: resource.error || options.error, setEnvironmentId, refresh, createRoom,
    roomsLoading: options.loading, hasMoreRooms: Boolean(options.data?.pageInfo.hasNextPage), loadMoreRooms,
  }), [rooms, ready, canOperate, projectId, environments, environmentId, environment, resource.error, options.error, setEnvironmentId, refresh, createRoom, options.loading, options.data, loadMoreRooms]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRooms() {
  const context = useContext(Context);
  if (!context) throw new Error("useRooms must be used within RoomsProvider");
  return context;
}
