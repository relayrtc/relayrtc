import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "../services/api/node_modules/fastify/fastify.js";
import { migrate } from "../services/api/node_modules/drizzle-orm/postgres-js/migrator.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../packages/database/src/index.js";
import { createRelayKitSessionVerifier } from "../packages/auth/src/server.js";
import {
  organizationQuotaResponseSchema,
  organizationUsageResponseSchema,
  projectAnalyticsResponseSchema,
  projectUsageResponseSchema,
} from "../packages/validation/src/reporting.js";
import { createMediaUsageMetricsStore } from "../services/media/src/usage/usage-metrics-store.js";
import { reportingRoutes } from "../services/api/src/modules/reporting/reporting.routes.js";
import { registerErrorHandling } from "../services/api/src/http/errors/error-handler.js";
import { refreshUsageAggregates } from "../services/api/src/modules/reporting/usage-aggregation.service.js";
import { proxyReportingRequest } from "../apps/console/lib/reporting-proxy.js";
import { reportingCsv } from "../apps/console/lib/reporting-api.js";

const databaseUrl = process.env.RELAYRTC_TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/relayrtc_usage_test")
  throw new Error("A dedicated relayrtc_usage_test database is required");
const secret = "xp6-signed-console-session-secret-123";
const cookie = `better-auth.session_token=${encodeURIComponent("xp6-token." + createHmac("sha256", secret).update("xp6-token").digest("base64"))}`;

async function fetchReporting<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  sessionCookie: string,
  origin: string,
) {
  const response = await proxyReportingRequest(
    new Request(new URL("/api/reporting/" + path.slice("/v1/".length), origin), {
      headers: { cookie: sessionCookie },
    }),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  if (!response.ok)
    throw Object.assign(new Error(`Reporting returned HTTP ${String(response.status)}`), {
      status: response.status,
    });
  return schema.parse(await response.json());
}

describe.skipIf(!databaseUrl)("persisted metering through Fastify and console reporting", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test", {
    maxConnections: 1,
  });
  const query = (statement: string) =>
    database.client.unsafe<
      { granularity: string; window_started_at: string; metrics: Record<string, number> }[]
    >(statement);
  let app: FastifyInstance;
  let origin: string;
  let cleanupStatements: string[];
  const cleanup = () =>
    database.client.begin(async (transaction) => {
      for (const statement of cleanupStatements)
        await transaction.unsafe(statement, [["org_xp6", "org_xp6_other"]]);
      await transaction.unsafe(`DELETE FROM "user" WHERE id='user_xp6'; SET TIME ZONE 'UTC';`);
    });
  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../packages/database/migrations", import.meta.url)),
    });
    cleanupStatements = (
      await readFile(new URL("./reporting-cleanup.sql", import.meta.url), "utf8")
    ).split("--> statement-breakpoint");
  }, 30_000);
  beforeEach(async () => {
    await cleanup();
    app = Fastify();
    registerErrorHandling(app);
    await app.register(reportingRoutes, {
      database: database.db,
      verifyConsoleSession: createRelayKitSessionVerifier({
        database: database.db,
        baseUrl: "http://localhost:3002",
        secret,
      }),
      prefix: "/v1",
    });
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.stubEnv("RELAYRTC_API_URL", origin);
    await query(`INSERT INTO organization (id, name, slug) VALUES ('org_xp6', 'Flow', 'flow-xp6'), ('org_xp6_other', 'Other', 'other-xp6');
      INSERT INTO project (id, organization_id, name, slug) VALUES ('project_xp6', 'org_xp6', 'Flow', 'flow'), ('project_xp6_other', 'org_xp6_other', 'Other', 'other');
      INSERT INTO environment (id, project_id, name, slug, type) VALUES ('env_xp6', 'project_xp6', 'One', 'one', 'custom'), ('env_xp6_empty', 'project_xp6', 'Empty', 'empty', 'custom'), ('env_xp6_other', 'project_xp6_other', 'Other', 'other', 'custom');
      INSERT INTO "user" (id, name, email, updated_at) VALUES ('user_xp6', 'Flow', 'xp6@example.com', now());
      INSERT INTO member (id, organization_id, user_id, role) VALUES ('member_xp6', 'org_xp6', 'user_xp6', 'owner');
      INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ('auth_xp6', 'xp6-token', 'user_xp6', now() + interval '1 hour', now());`);
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
    await cleanup();
  });
  afterAll(async () => {
    await database.close();
  });

  async function createRoom(start = new Date(Date.now() - 3600_000), end: Date | null = null) {
    await database.client.unsafe(
      `
      INSERT INTO room(id,project_id,environment_id,name,max_participants,status,created_at,started_at,ended_at)
      VALUES('room_xp6','project_xp6','env_xp6','Metered room',100,
        CASE WHEN $2::timestamptz IS NULL THEN 'active' ELSE 'ended' END,$1,$1,$2)
    `,
      [start.toISOString(), end?.toISOString() ?? null],
    );
  }
  const environmentAggregates = `organization_id='org_xp6' AND project_id='project_xp6' AND environment_id='env_xp6'`;

  it("persists fractional media samples once and presents project, organization, analytics and quota responses", async () => {
    await createRoom();
    await query(`INSERT INTO participant (id, room_id, name, joined_at) VALUES ('participant_xp6', 'room_xp6', 'Flow', now() - interval '2 minutes');
      INSERT INTO participant_session (id, participant_id, signaling_node_id, joined_at, metering_started_at) VALUES ('rtc_xp6', 'participant_xp6', 'node_xp6', now() - interval '2 minutes', now() - interval '2 minutes');
      UPDATE participant_session SET messages_in = 5, messages_out = 7 WHERE id = 'rtc_xp6';
      UPDATE participant_session SET connection_state = 'disconnected', disconnected_at = now() - interval '1 minute' WHERE id = 'rtc_xp6';`);
    const store = createMediaUsageMetricsStore(database.db);
    const occurredAt = new Date(Date.now() - 1000);
    for (let retry = 0; retry < 2; retry++)
      await store.recordBatch(
        "room_xp6",
        "sample_xp6",
        {
          audioParticipantSeconds: 1.25,
          videoParticipantSeconds: 2.75,
          sfuIngressBytes: 1000,
          screenShareSeconds: 0.5,
        },
        occurredAt,
      );
    await expect(
      store.recordBatch(
        "room_xp6",
        "invalid_xp6",
        { sfuIngressBytes: NaN, videoParticipantSeconds: -1 },
        occurredAt,
      ),
    ).rejects.toThrow("Invalid sfuIngressBytes usage sample");
    expect(await query("SELECT id FROM media_usage_sample WHERE id='invalid_xp6'")).toHaveLength(0);
    const usage = await fetchReporting(
      "/v1/projects/project_xp6/usage?range=7d",
      projectUsageResponseSchema,
      cookie,
      origin,
    );
    expect(usage.summary).toMatchObject({
      audioParticipantSeconds: 1.25,
      videoParticipantSeconds: 2.75,
      sfuIngressBytes: 1000,
      screenShareSeconds: 0.5,
      messagesIn: 5,
      messagesOut: 7,
      peakConcurrentParticipants: 1,
    });
    expect(usage.summary.participantSeconds).toBeCloseTo(60, 0);
    expect(usage.buckets.reduce((sum, bucket) => sum + bucket.participantSeconds, 0)).toBeCloseTo(
      usage.summary.participantSeconds,
      6,
    );
    const organization = await fetchReporting(
      "/v1/organizations/org_xp6/usage?range=7d",
      organizationUsageResponseSchema,
      cookie,
      origin,
    );
    expect(organization.summary.participantSeconds).toBe(usage.summary.participantSeconds);
    expect(organization.projects[0]?.summary.sfuIngressBytes).toBe(1000);
    const analytics = await fetchReporting(
      "/v1/projects/project_xp6/analytics?range=7d",
      projectAnalyticsResponseSchema,
      cookie,
      origin,
    );
    expect(analytics.topRooms[0]).toMatchObject({ name: "Metered room", participants: 1 });
    expect(analytics.topRooms[0]?.participantSeconds).toBeCloseTo(60, 0);
    const csv = reportingCsv(
      ["Room", "Participants", "Participant seconds"],
      analytics.topRooms.map((room) => [room.name, room.participants, room.participantSeconds]),
    );
    expect(csv).toContain('"Room","Participants","Participant seconds"');
    expect(csv).toContain('"Metered room","1",');
    expect(analytics.network.sfuIngressBytes).toBe(1000);
    expect(
      analytics.quality.every(
        (sample) => sample.roundTripTimeMs === null && sample.sampleCount === 0,
      ),
    ).toBe(true);
    const empty = await fetchReporting(
      "/v1/projects/project_xp6/usage?range=7d&environmentId=env_xp6_empty",
      projectUsageResponseSchema,
      cookie,
      origin,
    );
    expect(Object.values(empty.summary).every((value) => value === 0)).toBe(true);
    expect(
      await fetchReporting(
        "/v1/organizations/org_xp6/quota",
        organizationQuotaResponseSchema,
        cookie,
        origin,
      ),
    ).toMatchObject({ status: "unconfigured", limits: [] });
    await expect(
      fetchReporting(
        "/v1/organizations/org_xp6_other/usage",
        organizationUsageResponseSchema,
        cookie,
        origin,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await query(`DELETE FROM session WHERE id = 'auth_xp6'`);
    await expect(
      fetchReporting("/v1/projects/project_xp6/usage", projectUsageResponseSchema, cookie, origin),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rebuilds UTC event aggregates without duplication and incorporates late arrivals", async () => {
    const store = createMediaUsageMetricsStore(database.db);
    const at = new Date(Date.now() - 86400_000);
    at.setUTCHours(5, 30, 0, 0);
    const start = new Date(at);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 3600_000);
    await createRoom(start, new Date(at.getTime() + 60_000));
    await store.recordBatch(
      "room_xp6",
      "aggregate_xp6",
      { sfuIngressBytes: 100, audioParticipantSeconds: 1.25 },
      at,
    );
    await query(`SET TIME ZONE 'America/New_York'`);
    await refreshUsageAggregates(database.db, "org_xp6", start, end);
    await query(`SET TIME ZONE 'Asia/Kathmandu'`);
    await refreshUsageAggregates(database.db, "org_xp6", start, end);
    let rows = await query(
      `SELECT granularity, window_started_at, metrics FROM usage_aggregate WHERE ${environmentAggregates} ORDER BY granularity`,
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) =>
          row.metrics.sfuIngressBytes === 100 && row.metrics.audioParticipantSeconds === 1.25,
      ),
    ).toBe(true);
    const hour = rows.find((row) => row.granularity === "hour");
    if (!hour) throw new Error("Missing hourly aggregate");
    expect(new Date(hour.window_started_at).toISOString()).toBe(start.toISOString());
    await store.recordBatch("room_xp6", "late_xp6", { sfuIngressBytes: 25 }, at);
    await refreshUsageAggregates(database.db, "org_xp6", start, end);
    rows = await query(`SELECT metrics FROM usage_aggregate WHERE ${environmentAggregates}`);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics.sfuIngressBytes === 125)).toBe(true);
    await query(`DELETE FROM usage_event WHERE organization_id = 'org_xp6'`);
    await refreshUsageAggregates(database.db, "org_xp6", start, end);
    rows = await query(`SELECT metrics FROM usage_aggregate WHERE ${environmentAggregates}`);
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) => row.metrics.sfuIngressBytes === 0 && row.metrics.audioParticipantSeconds === 0,
      ),
    ).toBe(true);
  }, 30_000);

  it("rejects invalid aggregation windows and leaves existing rows unchanged on failure", async () => {
    const store = createMediaUsageMetricsStore(database.db);
    const start = new Date(Date.now() - 86400_000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 3600_000);
    await createRoom(start, new Date(start.getTime() + 60_000));
    await store.recordBatch("room_xp6", "atomic_xp6", { sfuIngressBytes: 100 }, start);
    await refreshUsageAggregates(database.db, "org_xp6", start, end);
    await expect(refreshUsageAggregates(database.db, "org_xp6", end, start)).rejects.toThrow();
    expect(
      await query(`SELECT * FROM usage_aggregate WHERE ${environmentAggregates}`),
    ).toHaveLength(3);
    await expect(refreshUsageAggregates(database.db, "org_missing", start, end)).rejects.toThrow(
      "Organization not found",
    );
    await store.recordBatch("room_xp6", "atomic_late_xp6", { sfuIngressBytes: 25 }, start);
    await query(
      `ALTER TABLE usage_aggregate ADD CONSTRAINT xp6_rebuild_failure CHECK (organization_id <> 'org_xp6' OR (metrics->>'sfuIngressBytes')::numeric <= 100)`,
    );
    try {
      await expect(refreshUsageAggregates(database.db, "org_xp6", start, end)).rejects.toThrow();
      const saved = await query(
        `SELECT metrics FROM usage_aggregate WHERE ${environmentAggregates}`,
      );
      expect(saved).toHaveLength(3);
      expect(saved.every((row) => row.metrics.sfuIngressBytes === 100)).toBe(true);
    } finally {
      await query("ALTER TABLE usage_aggregate DROP CONSTRAINT xp6_rebuild_failure");
    }
    await expect(
      fetchReporting(
        "/v1/projects/project_xp6/usage",
        projectUsageResponseSchema,
        "better-auth.session_token=forged",
        origin,
      ),
    ).rejects.toMatchObject({ status: 401 });
  }, 30_000);
});
