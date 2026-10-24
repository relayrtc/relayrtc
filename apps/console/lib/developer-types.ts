import type { ProjectDetails } from "./workspace-types";

export interface DeveloperProject extends ProjectDetails {
  availableScopes: string[];
  eventTypes: string[];
  signingConfigured: boolean;
}
export interface ApiKey {
  id: string; projectId: string; environmentId: string; name: string; type: "secret" | "publishable";
  prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null;
  expiresAt: string | null; revokedAt: string | null; createdBy: string | null;
}
export interface RevealedApiKey { apiKey: ApiKey; rawKey: string }
export interface WebhookEndpoint {
  id: string; projectId: string; environmentId: string; url: string; eventTypes: string[];
  status: "enabled" | "disabled"; createdAt: string; updatedAt: string;
  signingSecretVersion: number; signingSecretRotatedAt: string;
}
export interface RevealedWebhook extends WebhookEndpoint { signingSecret: string; rotationPolicy: "immediate replacement" }
export interface Pagination { limit: number; offset: number; total: number }
export interface WebhookList { endpoints: WebhookEndpoint[]; pagination: Pagination }
export type DeliveryStatus = "pending" | "delivering" | "succeeded" | "failed" | "cancelled";
export interface WebhookDelivery {
  id: string; endpointId: string; eventId: string; projectId: string; environmentId: string; url: string;
  status: DeliveryStatus; attemptCount: number; runAttemptCount: number; replayCount: number;
  lastError: string | null; nextAttemptAt: string | null; deliveredAt: string | null;
  runStartedAt: string; createdAt: string; updatedAt: string;
}
export interface WebhookDeliveryList { deliveries: WebhookDelivery[]; pagination: Pagination }
export interface WebhookAttempt {
  id: string; attemptNumber: number; replayCount: number; status: string; signingSecretVersion: number;
  signatureTimestamp: number; httpStatus: number | null; errorCode: string | null; startedAt: string; finishedAt: string | null;
}
export interface WebhookDeliveryDetail extends WebhookDelivery {
  event: { id: string; type: string; projectId: string; environmentId: string; occurredAt: string; data: Record<string, unknown> };
  rawBody: string; attempts: WebhookAttempt[];
}
export interface SignatureContract {
  version: string; algorithm: string; signatureHeader: string; deliveryIdHeader: string; replayCountHeader: string;
  secretVersionHeader: string; signedContent: string; signatureFormat: string; secretEncoding: string;
  toleranceSeconds: number; deduplication: string; attemptsPerRun: number; maximumExplicitReplays: number;
  backoffSeconds: number[]; retryPolicy: string; verification: string; replayDestination: string; retention: string;
}
