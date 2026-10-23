import type { z } from "zod";

export function sessionCookie(cookie: string) {
  return cookie
    .split(";")
    .map((value) => value.trim())
    .filter((value) => /^(?:__Secure-)?better-auth\.session_token=/.test(value))
    .join("; ");
}

export class ReportingApiError extends Error {
  constructor(public readonly status?: number) {
    super("Reporting is temporarily unavailable. Please try again.");
  }
}

export function reportingOrigin(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.RELAYRTC_API_URL;
  if (!configured && environment.NODE_ENV === "production") throw new ReportingApiError();
  let url: URL;
  try {
    url = new URL(configured ?? `http://localhost:${environment.API_PORT ?? "8080"}`);
  } catch {
    throw new ReportingApiError();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ReportingApiError();
  return url.origin;
}

export async function fetchReporting<T>(
  path: string,
  schema: z.ZodType<T>,
  cookie: string,
  origin: string,
) {
  if (!path.startsWith("/v1/") || path.includes("..") || path.includes("\\"))
    throw new ReportingApiError();
  try {
    const response = await fetch(new URL(path, origin), {
      headers: { cookie: sessionCookie(cookie), accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ReportingApiError(response.status);
    return schema.parse(await response.json());
  } catch (error) {
    if (error instanceof ReportingApiError) throw error;
    throw new ReportingApiError();
  }
}
