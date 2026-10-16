import type {
  EnvironmentId,
  IsoDateTime,
  JsonObject,
  ProjectId,
  WebhookDeliveryId,
  WebhookEndpointId,
  WebhookEventId,
} from "./common.js";

export const webhookEventTypes = [
  "stream.created",
  "stream.starting",
  "stream.live",
  "stream.reconnecting",
  "stream.ended",
  "stream.failed",
  "room.created",
  "room.started",
  "room.ended",
  "participant.joined",
  "participant.left",
  "participant.reconnected",
  "track.published",
  "track.unpublished",
  "connection.degraded",
  "connection.recovered",
] as const;

export type WebhookEventType = (typeof webhookEventTypes)[number];

export const webhookEndpointStatuses = ["enabled", "disabled"] as const;

export type WebhookEndpointStatus = (typeof webhookEndpointStatuses)[number];

export const webhookDeliveryStatuses = [
  "pending",
  "delivering",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];

export interface WebhookEndpoint {
  readonly id: WebhookEndpointId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly url: string;
  readonly eventTypes: readonly WebhookEventType[];
  readonly status: WebhookEndpointStatus;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface StoredWebhookEndpoint extends WebhookEndpoint {
  readonly encryptedSigningSecret: string;
  readonly signingSecretVersion: number;
}

export interface WebhookEvent {
  readonly id: WebhookEventId;
  readonly type: WebhookEventType;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly occurredAt: IsoDateTime;
  readonly data: JsonObject;
}

export interface WebhookDelivery {
  readonly id: WebhookDeliveryId;
  readonly endpointId: WebhookEndpointId;
  readonly event: WebhookEvent;
  readonly status: WebhookDeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: IsoDateTime | null;
  readonly deliveredAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
}

export interface WebhookDeliveryRecord {
  readonly id: WebhookDeliveryId;
  readonly endpointId: WebhookEndpointId;
  readonly eventId: WebhookEventId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly url: string;
  readonly status: WebhookDeliveryStatus;
  readonly attemptCount: number;
  readonly runAttemptCount: number;
  readonly replayCount: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: IsoDateTime | null;
  readonly deliveredAt: IsoDateTime | null;
  readonly runStartedAt: IsoDateTime;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export const webhookDeliveryAttemptStatuses = [
  "started",
  "succeeded",
  "failed",
  "abandoned",
] as const;
export type WebhookDeliveryAttemptStatus = (typeof webhookDeliveryAttemptStatuses)[number];

export interface WebhookDeliveryAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly replayCount: number;
  readonly status: WebhookDeliveryAttemptStatus;
  readonly signingSecretVersion: number;
  readonly signatureTimestamp: number;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly startedAt: IsoDateTime;
  readonly finishedAt: IsoDateTime | null;
}

export interface WebhookDeliveryDetail extends WebhookDeliveryRecord {
  readonly event: WebhookEvent;
  readonly rawBody: string;
  readonly attempts: readonly WebhookDeliveryAttempt[];
}

export interface WebhookDeliveryList {
  readonly deliveries: readonly WebhookDeliveryRecord[];
  readonly pagination: { readonly limit: number; readonly offset: number; readonly total: number };
}

export interface ReplayWebhookDeliveryInput {
  readonly expectedReplayCount: number;
}
