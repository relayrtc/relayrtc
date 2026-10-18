export const scheduleEventTypes = [
  "schedule.created",
  "schedule.updated",
  "schedule.starting",
  "schedule.started",
  "schedule.missed",
  "schedule.cancelled",
  "schedule.failed",
  "schedule.completed",
  "schedule.reminder",
] as const;
export type ScheduleState =
  "scheduled" | "starting" | "running" | "ending" | "completed" | "missed" | "failed" | "cancelled";
export interface ScheduleTiming {
  startsAt: string;
  endsAt: string;
  timeZone: string;
  sourceWaitSeconds: number;
  catchUpSeconds: number;
  publisherEarlySeconds: number;
  viewerEarlySeconds: number;
  viewerAfterSeconds: number;
  notifyBeforeSeconds: number | null;
}
export interface ScheduledBroadcast extends ScheduleTiming {
  id: string;
  streamId: string;
  broadcastId: string;
  operationId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  name: string;
  state: ScheduleState;
  version: number;
  lastError: string | null;
  publisherOpensAt: string;
  viewerOpensAt: string;
  viewerClosesAt: string;
  readinessDeadline: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}
export interface ScheduleOperation {
  id: string;
  scheduleId: string;
  broadcastId: string;
  broadcastOperationId: string | null;
  status: "pending" | "completed" | "failed" | "cancelled";
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface ScheduledPlayback {
  scheduleId: string;
  streamId: string;
  broadcastId: string;
  state: "ready" | "starting" | "live" | "ended" | "failed";
  scheduleState: ScheduleState;
  sourceSessionId: string | null;
  generation: number | null;
  startsAt: string;
  endsAt: string;
  serverTime: string;
  countdownSeconds: number;
  publisherOpensAt: string;
  viewerOpensAt: string;
  viewerClosesAt: string;
}
