import type { ApiKey } from "./developer-types";

export const developerPath = (projectId: string) => `/api/account/developer/projects/${encodeURIComponent(projectId)}`;
export const webhookPath = (projectId: string, environmentId: string, endpointId?: string) =>
  `${developerPath(projectId)}/environments/${encodeURIComponent(environmentId)}/webhooks${endpointId ? `/${encodeURIComponent(endpointId)}` : ""}`;
export const projectHref = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
export const webhookHref = (projectId: string, environmentId: string, endpointId: string) =>
  `${projectHref(projectId)}/webhooks/${encodeURIComponent(environmentId)}/${encodeURIComponent(endpointId)}`;
export function apiKeyStatus(key: ApiKey) {
  return key.revokedAt ? "Revoked" : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? "Expired" : "Active";
}
