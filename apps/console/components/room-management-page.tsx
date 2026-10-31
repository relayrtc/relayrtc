"use client";

import Link from "next/link";
import { roomLookupPath } from "@/lib/room-api";
import type { RoomOverviewData } from "@/lib/room-types";
import { roomStatusName } from "@/lib/rooms";
import { Icon } from "@/ui/icon";
import { StatusPill } from "@/ui/status-pill";
import { WorkspaceState } from "@/ui/workspace-state";
import { useWorkspaceResource } from "./use-workspace-resource";
import { useRealtimeRefresh } from "./use-realtime-refresh";
import { RoomAudit } from "./room-audit";
import { RoomInvitations } from "./room-invitations";

export function RoomManagementPage({
  roomId,
  view,
}: {
  roomId: string;
  view: "audit" | "invitations";
}) {
  const resource = useWorkspaceResource<RoomOverviewData>(roomLookupPath(roomId));
  useRealtimeRefresh(resource.refresh);
  if (!resource.data)
    return (
      <WorkspaceState
        title="Loading room"
        error={resource.error}
        onRetry={() => {
          void resource.refresh().catch(() => undefined);
        }}
      />
    );
  const { room, canOperate, tokenSigningAvailable } = resource.data;
  const available = room.status === "created" || room.status === "active";
  return (
    <section className="content rooms-overview" aria-label={`${room.name} ${view}`}>
      <Link className="rooms-back" href={`/rooms/${encodeURIComponent(roomId)}/overview`}>
        <Icon name="chevronLeft" size={16} />
        Room overview
      </Link>
      <div className="panel room-card room-overview-summary">
        <span className="room-symbol">
          <Icon name="rooms" size={23} />
        </span>
        <div className="room-card-copy">
          <h2 className="room-card-name">{room.name}</h2>
          <span className="room-card-meta">
            {view === "audit" ? "Room audit log" : "Room invitations"}
          </span>
        </div>
        <StatusPill active={room.status === "active"}>{roomStatusName(room.status)}</StatusPill>
      </div>
      {view === "audit" ? (
        <RoomAudit projectId={room.projectId} roomId={room.id} />
      ) : (
        <RoomInvitations
          projectId={room.projectId}
          roomId={room.id}
          canOperate={canOperate && available}
          canRedeem={canOperate && available && tokenSigningAvailable}
        />
      )}
    </section>
  );
}
