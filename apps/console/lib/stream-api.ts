import { accountRequest, AccountApiError } from "./account-api";

export function streamingPath(projectId: string, environmentId: string, path: string, query: Record<string, string> = {}) {
  const parameters = new URLSearchParams({ ...query, projectId, environmentId });
  return `/api/streaming/${path}?${parameters}`;
}

// Keep the same command key when retrying an uncertain transport failure.
// These short-lived entries are memory only and contain no payload or secret.
const uncertain = new Map<string, { key: string; createdAt: number }>();
export async function streamCommand<T = unknown>(path: string, body: unknown = {}, method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST"): Promise<T> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
  const intent = `${method}:${path}:${digest}`;
  for (const [id, entry] of uncertain) if (Date.now() - entry.createdAt > 600000) uncertain.delete(id);
  const key = uncertain.get(intent)?.key ?? crypto.randomUUID();
  uncertain.set(intent, { key, createdAt: Date.now() });
  try {
    const result = await accountRequest<T>(path, body, undefined, { method, idempotencyKey: key });
    uncertain.delete(intent); return result;
  } catch (error) {
    if (error instanceof AccountApiError && error.status < 500) uncertain.delete(intent);
    throw error;
  }
}
