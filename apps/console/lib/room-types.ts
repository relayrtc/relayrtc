import type { Project, ProjectEnvironment } from "./workspace-types";

export type RoomStatus = "created" | "active" | "ending" | "ended" | "failed";
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";
export interface RoomStats {
  totalParticipants: number; connectedParticipants: number; totalSessions: number; connectedSessions: number;
  disconnectedSessions: number; reconnectingSessions: number; messagesIn: number; messagesOut: number;
}
export interface Room {
  id: string; projectId: string; environmentId: string; name: string; status: RoomStatus;
  maxParticipants: number; metadata: Record<string, unknown>; createdAt: string; startedAt: string | null; endedAt: string | null;
  stats: RoomStats;
}
export interface RoomContext {
  project: Project; environments: ProjectEnvironment[]; role: string; canOperate: boolean;
  tokenPermissions: string[]; tokenSigningAvailable: boolean;
}
export interface RoomConnection {
  nodes: Room[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; observedAt: string;
}
export interface RuntimeOperation { id: string; kind: string; status: "pending" | "running" | "failed" | "completed"; attempts: number; completedAt: string | null }
export interface RoomOverviewData {
  room: Room; project: Project; environment: ProjectEnvironment; canOperate: boolean;
  tokenPermissions: string[]; tokenSigningAvailable: boolean; operation: RuntimeOperation | null; observedAt: string;
}
export interface RoomSession {
  id: string; participantId: string; name: string; role: string; externalId: string | null;
  leftAt: string | null; removedAt: string | null; state: ConnectionState; transport: "tcp" | "udp" | "tls";
  joinedAt: string; disconnectedAt: string | null; reconnectedAt: string | null;
  messagesIn: number; messagesOut: number; live: boolean; connectionSeconds: number;
}
export interface RoomSessions {
  sessions: RoomSession[]; pagination: { limit: number; offset: number; total: number }; observedAt: string;
}
export interface RoomSessionDetail {
  session: RoomSession & { country: string | null; countryCode: string | null; metadata: Record<string, unknown> };
  observedAt: string; operation: RuntimeOperation | null;
}
export interface RealtimeSummary extends RoomStats { totalRooms: number; activeRooms: number; createdRooms: number; observedAt: string }
export interface ParticipantToken { expiresAt: string; participantId: string; token: string; tokenId: string }
