import type { RelayKitDatabase } from "@relayrtc/database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authenticateApiKey } from "../../authentication/api-key-authenticator.js";
import { registerErrorHandling } from "../../http/errors/error-handler.js";
import { createReportingAccessRepository } from "./reporting-access.js";
import { getProjectUsage } from "./project-usage.service.js";
import { getOrganizationUsage } from "./organization-usage.service.js";
import { getProjectAnalytics } from "./project-analytics.service.js";
import {
  organizationUsageResponseSchema,
  projectAnalyticsResponseSchema,
  projectUsageResponseSchema,
  reportingUsageMetricsSchema,
} from "@relayrtc/validation";
import { reportingRoutes } from "./reporting.routes.js";

vi.mock("../../authentication/api-key-authenticator.js", () => ({ authenticateApiKey: vi.fn() }));
vi.mock("./project-usage.service.js", () => ({ getProjectUsage: vi.fn() }));
vi.mock("./organization-usage.service.js", () => ({ getOrganizationUsage: vi.fn() }));
vi.mock("./project-analytics.service.js", () => ({ getProjectAnalytics: vi.fn() }));
vi.mock("./reporting-access.js", async (original) => ({
  ...(await original<typeof import("./reporting-access.js")>()),
  createReportingAccessRepository: vi.fn(),
}));

const access = {
  project: vi.fn(),
  isMember: vi.fn(),
  environmentBelongsToProject: vi.fn(),
};
const verifyConsoleSession = vi.fn();
const apps = new Set<FastifyInstance>();
const createApp = () => {
  const app = Fastify();
  registerErrorHandling(app);
  void app.register(reportingRoutes, {
    database: {
      transaction: async (load: (db: unknown) => Promise<unknown>) => load({ execute: vi.fn() }),
    } as unknown as RelayKitDatabase,
    verifyConsoleSession,
    prefix: "/v1",
  });
  apps.add(app);
  return app;
};
const cookie = { cookie: "better-auth.session_token=signed-session" };

beforeEach(() => {
  vi.mocked(getProjectAnalytics).mockResolvedValue(
    projectAnalyticsResponseSchema.parse({
      scope: { organizationId: "org_1", projectId: "project_1", environmentId: "env_1" },
      window: {
        range: "live",
        startedAt: "2026-10-08T11:45:00.000Z",
        endedAt: "2026-10-08T12:00:00.000Z",
        timezone: "UTC",
        endExclusive: true,
      },
      summary: {
        peakConcurrent: 0,
        totalSessions: 0,
        averageSessionSeconds: 0,
        participantSeconds: 0,
        connectionSuccessRate: 0,
      },
      network: { sfuIngressBytes: 0, sfuEgressBytes: 0, turnIngressBytes: 0, turnEgressBytes: 0 },
      traffic: [],
      networkSeries: [],
      quality: [],
      regions: [],
      qualityDistribution: [],
      topRooms: [],
      qualityGranularitySeconds: 60,
      dataQuality: { sessionHistory: "complete", messageHistory: "complete" },
    }),
  );
  vi.mocked(getOrganizationUsage).mockResolvedValue(
    organizationUsageResponseSchema.parse({
      organizationId: "org_1",
      window: {
        range: "30d",
        startedAt: "2026-09-08T00:00:00.000Z",
        endedAt: "2026-10-08T00:00:00.000Z",
        timezone: "UTC",
        endExclusive: true,
      },
      summary: Object.fromEntries(
        Object.keys(reportingUsageMetricsSchema.shape).map((key) => [key, 0]),
      ),
      projects: [],
      pagination: { limit: 10, offset: 0, total: 0 },
      dataQuality: { sessionHistory: "complete", messageHistory: "complete" },
    }),
  );
  vi.mocked(getProjectUsage).mockResolvedValue(
    projectUsageResponseSchema.parse({
      scope: { organizationId: "org_1", projectId: "project_1", environmentId: "env_1" },
      window: {
        range: "7d",
        startedAt: "2026-10-01T00:00:00.000Z",
        endedAt: "2026-10-08T00:00:00.000Z",
        timezone: "UTC",
        endExclusive: true,
      },
      summary: Object.fromEntries(
        Object.keys(reportingUsageMetricsSchema.shape).map((key) => [key, 0]),
      ),
      buckets: [],
      dataQuality: { sessionHistory: "complete", messageHistory: "complete" },
    }),
  );
  vi.mocked(createReportingAccessRepository).mockReturnValue(access);
  access.project.mockResolvedValue({ organizationId: "org_1", status: "active" });
  access.isMember.mockResolvedValue(true);
  access.environmentBelongsToProject.mockResolvedValue(true);
  verifyConsoleSession.mockImplementation((headers: Headers) =>
    Promise.resolve(headers.get("cookie") === cookie.cookie ? { userId: "user_1" } : null),
  );
  vi.mocked(authenticateApiKey).mockResolvedValue({
    environmentId: "env_1",
    keyId: "key_1",
    keyType: "secret",
    projectId: "project_1",
    scopes: ["usage:read", "analytics:read"],
  });
});
afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
  vi.clearAllMocks();
});

describe("versioned reporting routes", () => {
  it.each([
    "/v1/organizations/org_1/usage",
    "/v1/organizations/org_1/quota",
    "/v1/projects/project_1/usage",
    "/v1/projects/project_1/analytics",
  ])("requires credentials for %s", async (url) => {
    const response = await createApp().inject({ url });
    expect(response.statusCode).toBe(401);
    expect(access.project).not.toHaveBeenCalled();
    expect(access.isMember).not.toHaveBeenCalled();
  });
  it("returns unconfigured quota without a fabricated allowance", async () => {
    const response = await createApp().inject({
      url: "/v1/organizations/org_1/quota",
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      organizationId: "org_1",
      status: "unconfigured",
      limits: [],
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
  it.each(["/v1/projects/project_1/analytics?range=live"])(
    "serves the selected analytics range for %s",
    async (url) => {
      const response = await createApp().inject({ url, headers: cookie });
      expect(response.statusCode).toBe(200);
      expect(getProjectAnalytics).toHaveBeenCalledWith(
        expect.anything(),
        { organizationId: "org_1", projectId: "project_1", environmentId: null },
        "live",
      );
    },
  );
  it("passes the organization, range, and pagination to the usage service", async () => {
    const response = await createApp().inject({
      url: "/v1/organizations/org_1/usage?range=30d&limit=10&offset=0",
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(getOrganizationUsage).toHaveBeenCalledWith(expect.anything(), "org_1", {
      range: "30d",
      limit: 10,
      offset: 0,
    });
    expect(response.json()).toMatchObject({
      organizationId: "org_1",
      dataQuality: { sessionHistory: "complete" },
    });
  });
  it.each(["usage", "quota"])("hides organization %s from nonmembers", async (route) => {
    access.isMember.mockResolvedValue(false);
    const response = await createApp().inject({
      url: `/v1/organizations/org_other/${route}`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(404);
    expect(getOrganizationUsage).not.toHaveBeenCalled();
  });
  it("passes the key's enforced environment and selected range to the usage service", async () => {
    const response = await createApp().inject({
      url: "/v1/projects/project_1/usage?range=14d",
      headers: { authorization: "Bearer valid" },
    });
    expect(response.statusCode).toBe(200);
    expect(getProjectUsage).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: "org_1",
        projectId: "project_1",
        environmentId: "env_1",
      },
      "14d",
    );
    expect(response.json()).toMatchObject({ summary: { participantSeconds: 0 } });
  });
  it("allows console members to request all project environments", async () => {
    const response = await createApp().inject({
      url: "/v1/projects/project_1/usage",
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(getProjectUsage).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: "org_1",
        projectId: "project_1",
        environmentId: null,
      },
      "7d",
    );
  });
  it.each([
    "/v1/projects/project_1/analytics?range=14d",
    "/v1/projects/project_1/analytics?range=all",
    "/v1/projects/project_1/usage?organizationId=org_other",
    "/v1/projects/project_1/usage?range=7d&range=30d",
    "/v1/organizations/org_1/usage?limit=101",
    "/v1/organizations/org_1/usage?offset=-1",
    "/v1/organizations/org_1/quota?range=7d",
  ])("rejects invalid queries: %s", async (url) => {
    const response = await createApp().inject({ url, headers: cookie });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("does not fall back to the console cookie for an invalid API key", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const response = await createApp().inject({
      url: "/v1/projects/project_1/usage",
      headers: { ...cookie, authorization: "Bearer invalid" },
    });
    expect(response.statusCode).toBe(401);
    expect(verifyConsoleSession).not.toHaveBeenCalled();
  });
  it("rejects malformed authorization even with a console cookie", async () => {
    const response = await createApp().inject({
      url: "/v1/projects/project_1/usage",
      headers: { ...cookie, authorization: "Basic invalid" },
    });
    expect(response.statusCode).toBe(401);
  });
  it.each(["usage", "quota"])(
    "rejects organization %s access with a project key",
    async (route) => {
      const response = await createApp().inject({
        url: `/v1/organizations/org_1/${route}`,
        headers: { authorization: "Bearer valid" },
      });
      expect(response.statusCode).toBe(403);
    },
  );
  it("rejects spoofed project headers", async () => {
    const response = await createApp().inject({
      url: "/v1/projects/project_1/usage",
      headers: { authorization: "Bearer valid", "x-relayrtc-project-id": "project_other" },
    });
    expect(response.statusCode).toBe(403);
  });
  it("rejects foreign environments and foreign projects", async () => {
    const app = createApp();
    for (const url of [
      "/v1/projects/project_other/usage",
      "/v1/projects/project_1/analytics?environmentId=env_other",
    ]) {
      const response = await app.inject({ url, headers: { authorization: "Bearer valid" } });
      expect(response.statusCode).toBe(403);
    }
  });
  it("rejects removed memberships on a subsequent request", async () => {
    const app = createApp();
    expect(
      (await app.inject({ url: "/v1/organizations/org_1/quota", headers: cookie })).statusCode,
    ).toBe(200);
    access.isMember.mockResolvedValue(false);
    expect(
      (await app.inject({ url: "/v1/organizations/org_1/quota", headers: cookie })).statusCode,
    ).toBe(404);
  });
});
