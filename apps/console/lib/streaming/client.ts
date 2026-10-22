import "server-only";
import { headers } from "next/headers";
import { z } from "zod";
import { reportingOrigin, sessionCookie } from "@/lib/reporting/request";
type StreamingResult<T> = { data: T; error: null } | { data: null; error: { code: string; description: string } };

const errorSchema = z.object({ code: z.string().max(100), description: z.string().max(600) });

export async function requestStreaming<Output>(
  projectId: string,
  environmentId: string,
  path: string,
  schema: { parse(value: unknown): Output },
  method = "GET",
  body?: unknown,
  query: Record<string, string> = {},
  idempotencyKey?: string,
): Promise<StreamingResult<Output>> {
  try {
    const cookie = sessionCookie((await headers()).get("cookie") ?? "");
    if (!cookie)
      return {
        data: null,
        error: { code: "AUTHENTICATION_REQUIRED", description: "Sign in to access streams." },
      };
    const requestHeaders: Record<string, string> = { cookie, accept: "application/json" };
    if (method !== "GET") {
      if (!process.env.BETTER_AUTH_URL) throw new Error("Console origin unavailable");
      requestHeaders.origin = new URL(process.env.BETTER_AUTH_URL).origin;
    }
    if (idempotencyKey) requestHeaders["idempotency-key"] = idempotencyKey;
    if (body !== undefined) requestHeaders["content-type"] = "application/json";
    const parameters = new URLSearchParams({ ...query, projectId, environmentId });
    const response = await fetch(new URL(`/v1/${path}?${parameters}`, reportingOrigin()), {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = errorSchema.safeParse(payload);
      if (
        error.success &&
        [
          "STREAMING_DISABLED",
          "BROADCASTS_DISABLED",
          "MIXERS_DISABLED",
          "DVR_DISABLED",
          "GUEST_STAGE_UNAVAILABLE",
          "DESTINATION_ENCRYPTION_UNAVAILABLE",
        ].includes(error.data.code)
      )
        return { data: null, error: error.data };
      if (error.success && error.data.code === "ROUTE_NOT_FOUND")
        return {
          data: null,
          error: {
            code: "STREAMING_API_MISSING",
            description:
              "The API is missing streaming routes. Rebuild and start the streaming services with pnpm docker:up:streaming.",
          },
        };
      if (error.success && response.status < 500) return { data: null, error: error.data };
      throw new Error("Streaming API unavailable");
    }
    return { data: schema.parse(payload), error: null };
  } catch {
    return {
      data: null,
      error: {
        code: "STREAMING_UNAVAILABLE",
        description: "Streaming is unavailable. Check that streaming is enabled or try again.",
      },
    };
  }
}
