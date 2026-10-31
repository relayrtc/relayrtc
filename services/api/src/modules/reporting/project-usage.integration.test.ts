import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase } from "@relayrtc/database";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getProjectUsage } from "./project-usage.service.js";
import { getOrganizationUsage } from "./organization-usage.service.js";
import { getProjectAnalytics } from "./project-analytics.service.js";
import { getServiceUsage } from "./service-usage-report.js";
import { reportingRoutes } from "./reporting.routes.js";
import { registerErrorHandling } from "../../http/errors/error-handler.js";

const databaseUrl = process.env.RELAYRTC_TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/relayrtc_usage_test") {
  throw new Error("Usage integration tests require a dedicated relayrtc_usage_test database");
}
const scope = { organizationId: "org_1", projectId: "project_1", environmentId: null };
const now = new Date("2026-10-08T12:00:00.000Z");

describe.skipIf(!databaseUrl)("project usage against PostgreSQL", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test", {
    maxConnections: 1,
  });
  const query = (statement: string, values: string[] = []) =>
    database.client.unsafe(statement, values);
  let cleanupStatements: string[];
  let fixtureTransaction = false;
  const cleanup = () =>
    database.client.begin(async (transaction) => {
      for (const statement of cleanupStatements)
        await transaction.unsafe(statement, [["org_1", "org_2", "org_empty"]]);
      await transaction.unsafe(`DELETE FROM "user" WHERE id='user_1'`);
    });

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../../../packages/database/migrations", import.meta.url),
      ),
    });
    cleanupStatements = (
      await readFile(new URL("../../../../../tests/reporting-cleanup.sql", import.meta.url), "utf8")
    ).split("--> statement-breakpoint");
  }, 30_000);
  beforeEach(async () => {
    await cleanup();
    await query("BEGIN");
    fixtureTransaction = true;
    await query(
      `INSERT INTO organization (id, name, slug) VALUES ('org_1', 'Test', 'test'), ('org_2', 'Other', 'other')`,
    );
    await query(`INSERT INTO project (id, organization_id, name, slug) VALUES
      ('project_1', 'org_1', 'Test', 'test'), ('project_2', 'org_2', 'Other', 'other')`);
    await query(`INSERT INTO environment (id, project_id, name, slug, type) VALUES
      ('env_1', 'project_1', 'One', 'one', 'custom'), ('env_2', 'project_1', 'Two', 'two', 'custom'),
      ('env_other', 'project_2', 'Other', 'other', 'custom')`);
  });
  afterEach(async () => {
    if (fixtureTransaction) await query("ROLLBACK");
    await cleanup();
  });
  afterAll(async () => {
    await database.close();
  });

  it("attributes streaming intervals and boundary events once across all report scopes", async () => {
    await query(`INSERT INTO service_usage_sample
      (id,organization_id,project_id,environment_id,resource_type,resource_id,stream_id,run_id,metrics,started_at,ended_at,occurred_at,coverage) VALUES
      ('interval','org_1','project_1','env_1','stream','stream_1','stream_1','run_1','{"sourceSeconds":7200,"viewerSeconds":7200}','2026-10-08T09:30Z','2026-10-08T11:30Z','2026-10-08T11:30Z','observed'),
      ('boundary','org_1','project_1','env_1','stream','stream_1','stream_1','run_1','{"programBytes":123}','2026-10-08T10:00Z','2026-10-08T10:00Z','2026-10-08T10:00Z','observed'),
      ('outside','org_1','project_1','env_2','stream','stream_2','stream_2','run_2','{"programBytes":999}','2026-10-08T10:00Z','2026-10-08T10:00Z','2026-10-08T10:00Z','observed')`);
    const report = await getServiceUsage(
      database.db,
      { ...scope, environmentId: "env_1" },
      { startedAt: "2026-10-08T10:00:00Z", endedAt: "2026-10-08T12:00:00Z", granularity: "hour" },
      now,
    );
    expect(report.summary.sourceSeconds).toBe(5400);
    expect(report.summary.programBytes).toBe(123);
    expect(report.summary.peakConcurrentViewers).toBe(1);
    expect(report.buckets.map((b) => b.metrics.sourceSeconds)).toEqual([3600, 1800]);
    expect(report.buckets.map((b) => b.metrics.programBytes)).toEqual([123, 0]);
    expect(report.resources[0]?.metrics.sourceSeconds).toBe(5400);
    expect(report.projects[0]?.metrics.programBytes).toBe(123);
  });

  const room = async (id = "room_1", environment = "env_1", project = "project_1") => {
    await query(
      `INSERT INTO room (id, project_id, environment_id, name, max_participants, status, created_at, started_at)
      VALUES ($1, $2, $3, $1, 100, 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
      [id, project, environment],
    );
  };
  const session = async (id: string, participantId: string, joined: string, roomId = "room_1") => {
    await query(
      `INSERT INTO participant (id, room_id, name, joined_at) VALUES ($1, $2, $1, $3)
      ON CONFLICT (id) DO NOTHING`,
      [participantId, roomId, joined],
    );
    await query(
      `INSERT INTO participant_session (id, participant_id, signaling_node_id, joined_at, metering_started_at)
      VALUES ($1, $2, 'node_1', $3, $3)`,
      [id, participantId, joined],
    );
  };
  const disconnect = async (id: string, at: string) => {
    await query(
      `UPDATE participant_session SET connection_state = 'reconnecting', disconnected_at = $2 WHERE id = $1`,
      [id, at],
    );
  };
  const resume = async (id: string, at: string) => {
    await query(
      `UPDATE participant_session SET connection_state = 'connected', disconnected_at = NULL, reconnected_at = $2 WHERE id = $1`,
      [id, at],
    );
  };
  const organizationUsage = (limit = 50, offset = 0) =>
    getOrganizationUsage(database.db, "org_1", { range: "7d", limit, offset }, now);
  const extraProjects = async () => {
    await query(`INSERT INTO project (id, organization_id, name, slug, status) VALUES
      ('project_3', 'org_1', 'Three', 'three', 'active'), ('project_empty', 'org_1', 'Empty', 'empty', 'active')`);
    await query(`INSERT INTO environment (id, project_id, name, slug, type) VALUES
      ('env_3', 'project_3', 'Three', 'three', 'custom'), ('env_empty', 'project_empty', 'Empty', 'empty', 'custom')`);
  };

  it.each(["live", "24h", "7d", "30d"] as const)(
    "returns empty analytics without phantom activity for %s",
    async (range) => {
      const result = await getProjectAnalytics(database.db, scope, range, now);
      expect(Object.values(result.summary).every((value) => value === 0)).toBe(true);
      expect(result.topRooms).toEqual([]);
      expect(result.qualityDistribution).toEqual([]);
      expect(
        result.traffic.every(
          (point) =>
            point.participants === 0 && point.sessions === 0 && point.participantSeconds === 0,
        ),
      ).toBe(true);
      expect(
        result.quality.every(
          (point) =>
            point.sampleCount === 0 &&
            point.roundTripTimeMs === null &&
            point.packetLossPercent === null,
        ),
      ).toBe(true);
      expect(result.traffic[0]?.startedAt).toBe(result.window.startedAt);
      expect(result.traffic.at(-1)?.endedAt).toBe(result.window.endedAt);
    },
  );
  it("includes old rooms, excludes empty rooms, and counts only participants active in the period", async () => {
    await room();
    await room("room_empty");
    await session("s1", "p1", "2026-10-01T11:59:00Z");
    await disconnect("s1", "2026-10-01T12:02:00Z");
    await session("s2", "p2", "2026-09-01T10:00:00Z");
    await disconnect("s2", "2026-09-01T11:00:00Z");
    await session("s3", "p3", "2026-10-08T11:59:00Z");
    const result = await getProjectAnalytics(database.db, scope, "7d", now);
    expect(result.topRooms).toEqual([
      { id: "room_1", name: "room_1", participants: 2, participantSeconds: 180 },
    ]);
    expect(result.summary.totalSessions).toBe(2);
    expect(result.summary.averageSessionSeconds).toBe(90);
    expect(result.summary.participantSeconds).toBe(180);
    expect(result.traffic.reduce((total, point) => total + point.participantSeconds, 0)).toBe(180);
    expect(Math.max(...result.traffic.map((point) => point.participants))).toBe(
      result.summary.peakConcurrent,
    );
    expect(result.regions).toEqual([{ name: "Unknown", sessions: 2 }]);
  });
  it("keeps live analytics and usage durations consistent across reconnects and overlapping sessions", async () => {
    await room();
    await session("s1", "p1", "2026-10-08T11:00:00Z");
    await disconnect("s1", "2026-10-08T11:50:00Z");
    await resume("s1", "2026-10-08T11:55:00Z");
    await session("s2", "p1", "2026-10-08T11:56:00Z");
    const result = await getProjectAnalytics(database.db, scope, "live", now);
    expect(result.summary.participantSeconds).toBe(600);
    expect(result.summary.totalSessions).toBe(2);
    expect(result.summary.averageSessionSeconds).toBe(420);
    expect(result.summary.peakConcurrent).toBe(1);
    expect(result.topRooms[0]?.participants).toBe(1);
    expect(result.topRooms[0]?.participantSeconds).toBe(600);
    expect(result.traffic.reduce((total, point) => total + point.participantSeconds, 0)).toBe(600);
    const weekly = await getProjectAnalytics(database.db, scope, "7d", now);
    expect(weekly.summary.participantSeconds).toBe(
      (await getProjectUsage(database.db, scope, "7d", now)).summary.participantSeconds,
    );
  });
  it("filters all analytics sections by environment and uses exclusive network boundaries", async () => {
    await room();
    await room("room_2", "env_2");
    await session("s1", "p1", "2026-10-08T11:59:00Z");
    await session("s2", "p2", "2026-10-08T11:50:00Z", "room_2");
    await query(`UPDATE participant_session SET country = 'Japan' WHERE id = 's2'`);
    await query(`INSERT INTO usage_event (id, organization_id, project_id, environment_id, metric, value, occurred_at) VALUES
      ('e1', 'org_1', 'project_1', 'env_1', 'sfuIngressBytes', 100, '2026-10-08T11:45:00Z'),
      ('e2', 'org_1', 'project_1', 'env_1', 'sfuIngressBytes', 999, '2026-10-08T12:00:00Z'),
      ('e3', 'org_1', 'project_1', 'env_2', 'sfuIngressBytes', 888, '2026-10-08T11:59:00Z')`);
    const result = await getProjectAnalytics(
      database.db,
      { ...scope, environmentId: "env_1" },
      "live",
      now,
    );
    expect(result.summary.participantSeconds).toBe(60);
    expect(result.network.sfuIngressBytes).toBe(100);
    expect(result.networkSeries.reduce((total, point) => total + point.sfuIngressBytes, 0)).toBe(
      100,
    );
    expect(result.topRooms.map((item) => item.id)).toEqual(["room_1"]);
    expect(result.regions).toEqual([{ name: "Unknown", sessions: 1 }]);
  });
  it("weights quality samples, converts seconds to milliseconds, and counts the latest quality once per participant", async () => {
    await room();
    await session("s1", "p1", "2026-10-08T11:00:00Z");
    await query(`INSERT INTO rtc_quality_metric (room_id, participant_id, bucket_started_at, sample_count,
      round_trip_time_sample_count, round_trip_time_sum, jitter_sample_count, jitter_sum, packets_lost, packets_received,
      latest_quality, worst_quality, worst_quality_severity, updated_at) VALUES
      ('room_1', 'p1', '2026-10-08T11:58:00Z', 3, 1, 0.6, 3, 0.03, 0, 20, 'poor', 'poor', 2, '2026-10-08T11:58:30Z'),
      ('room_1', 'p1', '2026-10-08T11:59:00Z', 2, 2, 0.2, 1, 0.01, 2, 18, 'good', 'poor', 2, '2026-10-08T11:59:30Z')`);
    const result = await getProjectAnalytics(database.db, scope, "24h", now);
    const point = result.quality.find((item) => item.sampleCount > 0);
    expect(point?.sampleCount).toBe(5);
    expect(point?.roundTripTimeMs).toBeCloseTo(800 / 3);
    expect(point?.jitterMs).toBe(10);
    expect(point?.packetLossPercent).toBe(5);
    expect(result.qualityDistribution).toEqual([{ quality: "good", count: 1 }]);
    const live = await getProjectAnalytics(database.db, scope, "live", now);
    expect(
      live.quality.find((item) => item.startedAt === "2026-10-08T11:59:00.000Z")?.roundTripTimeMs,
    ).toBe(100);
  });
  it("limits Top rooms to ten and orders them by activity", async () => {
    for (let index = 0; index < 12; index++) {
      const id = `rank_${index.toString().padStart(2, "0")}`;
      await room(id);
      await session(
        `s_${id}`,
        `p_${id}`,
        new Date(now.getTime() - (index + 1) * 1000).toISOString(),
        id,
      );
    }
    const result = await getProjectAnalytics(database.db, scope, "live", now);
    expect(result.topRooms).toHaveLength(10);
    expect(result.topRooms.map((item) => item.participantSeconds)).toEqual([
      12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
    ]);
    expect(result.summary.participantSeconds).toBe(78);
  });
  it("excludes quality samples from other environments and outside the reporting window", async () => {
    await room();
    await room("room_2", "env_2");
    await session("s1", "p1", "2026-10-08T11:00:00Z");
    await session("s2", "p2", "2026-10-08T11:00:00Z", "room_2");
    await query(`INSERT INTO rtc_quality_metric (room_id, participant_id, bucket_started_at, sample_count,
      latest_quality, worst_quality, worst_quality_severity, updated_at) VALUES
      ('room_2', 'p2', '2026-10-08T11:59:00Z', 10, 'critical', 'critical', 3, '2026-10-08T11:59:30Z'),
      ('room_1', 'p1', '2026-10-08T11:44:00Z', 10, 'poor', 'poor', 2, '2026-10-08T11:44:30Z'),
      ('room_1', 'p1', '2026-10-08T12:00:00Z', 10, 'poor', 'poor', 2, '2026-10-08T12:00:30Z')`);
    const result = await getProjectAnalytics(
      database.db,
      { ...scope, environmentId: "env_1" },
      "live",
      now,
    );
    expect(result.quality.every((point) => point.sampleCount === 0)).toBe(true);
    expect(result.qualityDistribution).toEqual([]);
  });
  it("does not treat pending or never-connected sessions as successful connections", async () => {
    await room();
    await session("s1", "p1", "2026-10-08T11:59:00Z");
    await query(`INSERT INTO participant (id, room_id, name, joined_at) VALUES ('failed_p', 'room_1', 'Failed', '2026-10-08T11:59:00Z'),
      ('pending_p', 'room_1', 'Pending', '2026-10-08T11:59:00Z')`);
    await query(`INSERT INTO participant_session (id, participant_id, signaling_node_id, connection_state, joined_at, metering_started_at) VALUES
      ('failed', 'failed_p', 'node', 'failed', '2026-10-08T11:59:00Z', '2026-10-08T11:59:00Z'),
      ('pending', 'pending_p', 'node', 'connecting', '2026-10-08T11:59:00Z', '2026-10-08T11:59:00Z')`);
    const result = await getProjectAnalytics(database.db, scope, "live", now);
    expect(result.summary.totalSessions).toBe(3);
    expect(result.summary.connectionSuccessRate).toBe(50);
    expect(result.summary.participantSeconds).toBe(60);
    expect(result.topRooms[0]?.participants).toBe(1);
  });

  it("returns zero organization usage and includes empty projects without inventing a quota", async () => {
    const result = await organizationUsage();
    expect(Object.values(result.summary).every((value) => value === 0)).toBe(true);
    expect(result.projects.map((project) => project.projectId)).toEqual(["project_1"]);
    expect(result.pagination).toEqual({ limit: 50, offset: 0, total: 1 });
    const empty = await getOrganizationUsage(
      database.db,
      "org_2",
      { range: "7d", limit: 50, offset: 0 },
      now,
    );
    expect(empty.summary.participantSeconds).toBe(0);
    expect(result.dataQuality).toEqual({
      sessionHistory: "complete",
      messageHistory: "complete",
      turnTraffic: "unavailable",
    });
    await query(`INSERT INTO organization (id, name, slug) VALUES ('org_empty', 'Empty', 'empty')`);
    const noProjects = await getOrganizationUsage(
      database.db,
      "org_empty",
      { range: "7d", limit: 50, offset: 0 },
      now,
    );
    expect(noProjects.projects).toEqual([]);
    expect(noProjects.pagination.total).toBe(0);
    expect(Object.values(noProjects.summary).every((value) => value === 0)).toBe(true);
  });
  it("reconciles organization totals with projects and calculates simultaneous peaks", async () => {
    await extraProjects();
    await room();
    await room("room_3", "env_3", "project_3");
    await room("room_other", "env_other", "project_2");
    await session("s1", "p1", "2026-10-02T10:00:00Z");
    await disconnect("s1", "2026-10-02T10:10:00Z");
    await session("s3", "p3", "2026-10-02T10:10:00Z", "room_3");
    await disconnect("s3", "2026-10-02T10:20:00Z");
    await session("other", "other", "2026-10-02T00:00:00Z", "room_other");
    await query(
      `UPDATE room SET started_at = '2026-10-02T10:00:00Z', ended_at = '2026-10-02T10:10:00Z', status = 'ended' WHERE id = 'room_1'`,
    );
    await query(
      `UPDATE room SET started_at = '2026-10-02T10:10:00Z', ended_at = '2026-10-02T10:20:00Z', status = 'ended' WHERE id = 'room_3'`,
    );
    await query(`INSERT INTO usage_event (id, organization_id, project_id, environment_id, metric, value, occurred_at) VALUES
      ('e1', 'org_1', 'project_1', 'env_1', 'sfuIngressBytes', 100, '2026-10-02T12:00:00Z'),
      ('e3', 'org_1', 'project_3', 'env_3', 'sfuIngressBytes', 200, '2026-10-02T12:00:00Z'),
      ('other', 'org_2', 'project_2', 'env_other', 'sfuIngressBytes', 9999, '2026-10-02T12:00:00Z')`);
    await query("UPDATE project SET status='suspended' WHERE id='project_3'");
    const result = await organizationUsage();
    expect(result.summary.participantSeconds).toBe(1200);
    expect(result.summary.sfuIngressBytes).toBe(300);
    expect(result.summary.peakConcurrentParticipants).toBe(1);
    expect(result.summary.peakConcurrentRooms).toBe(1);
    for (const metric of Object.keys(result.summary) as (keyof typeof result.summary)[]) {
      if (metric === "peakConcurrentParticipants" || metric === "peakConcurrentRooms") continue;
      expect(result.projects.reduce((total, project) => total + project.summary[metric], 0)).toBe(
        result.summary[metric],
      );
    }
    expect(
      result.projects.reduce(
        (total, project) => total + project.summary.peakConcurrentParticipants,
        0,
      ),
    ).toBe(2);
    const page = await organizationUsage(1, 1);
    expect(page.projects.map((project) => project.projectId)).toEqual(["project_3"]);
    expect(page.summary).toEqual(result.summary);
    expect(page.pagination).toEqual({ limit: 1, offset: 1, total: 3 });
    const beyond = await organizationUsage(1, 99);
    expect(beyond.projects).toEqual([]);
    expect(beyond.summary).toEqual(result.summary);
  });
  it("counts overlapping activity across projects and retains environment consumption once", async () => {
    await extraProjects();
    await room();
    await room("room_3", "env_3", "project_3");
    await room("room_env2", "env_2");
    await session("s1", "p1", "2026-10-08T11:59:00Z");
    await session("s3", "p3", "2026-10-08T11:59:00Z", "room_3");
    await session("s2", "p2", "2026-10-08T11:59:00Z", "room_env2");
    await query("UPDATE project SET status='suspended' WHERE id='project_3'");
    const result = await organizationUsage();
    expect(result.summary.participantSeconds).toBe(180);
    expect(result.summary.peakConcurrentParticipants).toBe(3);
    expect(result.summary.peakConcurrentRooms).toBe(3);
    expect(
      result.projects.find((project) => project.projectId === "project_1")?.summary
        .participantSeconds,
    ).toBe(120);
  });
  it("preserves partial-history warnings even when the affected project is outside the page", async () => {
    await extraProjects();
    await room("room_3", "env_3", "project_3");
    await session("s3", "p3", "2026-10-02T10:00:00Z", "room_3");
    await query(
      `UPDATE participant_session SET metering_started_at = '2026-10-03T00:00:00Z' WHERE id = 's3'`,
    );
    await query("UPDATE project SET status='suspended' WHERE id='project_3'");
    const first = await organizationUsage(1, 0);
    expect(first.dataQuality).toEqual({
      sessionHistory: "partial",
      messageHistory: "partial",
      turnTraffic: "unavailable",
    });
    expect(first.projects[0]?.dataQuality.sessionHistory).toBe("complete");
    expect((await organizationUsage(1, 1)).projects[0]?.dataQuality.sessionHistory).toBe("partial");
  });

  it.each(["24h", "7d", "14d", "30d"] as const)(
    "returns zero usage and continuous empty buckets for %s",
    async (range) => {
      const result = await getProjectUsage(database.db, scope, range, now);
      expect(Object.values(result.summary).every((value) => value === 0)).toBe(true);
      expect(
        result.buckets.every(
          (bucket) => bucket.participantSeconds === 0 && bucket.roomsCreated === 0,
        ),
      ).toBe(true);
      expect(result.buckets[0]?.startedAt).toBe(result.window.startedAt);
      expect(result.buckets.at(-1)?.endedAt).toBe(result.window.endedAt);
      expect(result.dataQuality).toEqual({
        sessionHistory: "complete",
        messageHistory: "complete",
        turnTraffic: "unavailable",
      });
    },
  );
  it("clips older connections and future timestamps to the selected period", async () => {
    await room();
    await session("s1", "p1", "2026-10-01T11:59:00Z");
    await disconnect("s1", "2026-10-01T12:02:00Z");
    await session("s2", "p2", "2026-10-08T11:59:30Z");
    await disconnect("s2", "2026-10-09T00:00:00Z");
    const result = await getProjectUsage(database.db, scope, "7d", now);
    expect(result.summary.participantSeconds).toBe(150);
    expect(result.summary.signalingConnectionSeconds).toBe(150);
    expect(result.summary.signalingConnections).toBe(1);
    expect(result.summary.roomsCreated).toBe(0);
    expect(result.summary.peakConcurrentParticipants).toBe(1);
    expect(result.buckets.reduce((total, bucket) => total + bucket.participantSeconds, 0)).toBe(
      150,
    );
  });
  it("excludes reconnect gaps and does not accrue time while reconnecting", async () => {
    await room();
    await session("s1", "p1", "2026-10-02T10:00:00Z");
    await disconnect("s1", "2026-10-02T10:10:00Z");
    await resume("s1", "2026-10-02T10:20:00Z");
    await disconnect("s1", "2026-10-02T10:30:00Z");
    const result = await getProjectUsage(database.db, scope, "7d", now);
    expect(result.summary.participantSeconds).toBe(1200);
    expect(result.summary.signalingConnectionSeconds).toBe(1200);
    expect(result.summary.peakConcurrentParticipants).toBe(1);
    expect(
      (await query("SELECT * FROM participant_connection_interval WHERE session_id = 's1'")).length,
    ).toBe(2);
  });
  it("counts a participant once across overlapping sessions while preserving signaling time", async () => {
    await room();
    await session("s1", "p1", "2026-10-02T10:00:00Z");
    await session("s2", "p1", "2026-10-02T10:05:00Z");
    await disconnect("s1", "2026-10-02T10:10:00Z");
    await disconnect("s2", "2026-10-02T10:15:00Z");
    const result = await getProjectUsage(database.db, scope, "7d", now);
    expect(result.summary.participantSeconds).toBe(900);
    expect(result.summary.signalingConnectionSeconds).toBe(1200);
    expect(result.summary.peakConcurrentParticipants).toBe(1);
  });
  it("caps active connections at participant leave and room termination", async () => {
    await room();
    await session("s1", "p1", "2026-10-08T11:50:00Z");
    await session("s2", "p2", "2026-10-08T11:55:00Z");
    await query("UPDATE participant SET left_at = '2026-10-08T11:52:00Z' WHERE id = 'p1'");
    await query(
      "UPDATE room SET ended_at = '2026-10-08T11:58:00Z', status = 'ended' WHERE id = 'room_1'",
    );
    const result = await getProjectUsage(database.db, scope, "7d", now);
    expect(result.summary.participantSeconds).toBe(300);
    expect(result.summary.peakConcurrentParticipants).toBe(1);
  });
  it("caps ongoing connections at the report timestamp", async () => {
    await room();
    await session("s1", "p1", "2026-10-08T11:59:00.500Z");
    const result = await getProjectUsage(database.db, scope, "24h", now);
    expect(result.summary.participantSeconds).toBe(59.5);
    expect(result.buckets.reduce((total, bucket) => total + bucket.participantSeconds, 0)).toBe(
      59.5,
    );
  });
  it("does not create concurrency for zero-length connections or double-count simultaneous transitions", async () => {
    await room();
    await session("s0", "p0", "2026-10-02T10:00:00Z");
    await disconnect("s0", "2026-10-02T10:00:00Z");
    await session("s1", "p1", "2026-10-02T10:00:00Z");
    await disconnect("s1", "2026-10-02T10:10:00Z");
    await session("s2", "p2", "2026-10-02T10:10:00Z");
    await disconnect("s2", "2026-10-02T10:20:00Z");
    const result = await getProjectUsage(database.db, scope, "7d", now);
    expect(result.summary.participantSeconds).toBe(1200);
    expect(result.summary.peakConcurrentParticipants).toBe(1);
  });
  it("counts room creation in its period and ignores rooms that never became active", async () => {
    await query(`INSERT INTO room (id, project_id, environment_id, name, max_participants, created_at)
      VALUES ('r1', 'project_1', 'env_1', 'One', 10, '2026-10-01T12:00:00Z'),
      ('r2', 'project_1', 'env_1', 'Two', 10, '2026-10-08T12:00:00Z')`);
    const result = await getProjectUsage(database.db, scope, "7d", now);
    expect(result.summary.roomsCreated).toBe(1);
    expect(result.summary.peakConcurrentRooms).toBe(0);
    expect(result.buckets.reduce((total, bucket) => total + bucket.roomsCreated, 0)).toBe(1);
  });
  it("scopes event totals and connection durations by project and environment", async () => {
    await room();
    await room("room_2", "env_2");
    await room("room_other", "env_other", "project_2");
    await session("s1", "p1", "2026-10-08T11:59:00Z");
    await session("s2", "p2", "2026-10-08T11:58:00Z", "room_2");
    await session("s3", "p3", "2026-10-08T11:00:00Z", "room_other");
    await query(`INSERT INTO usage_event (id, organization_id, project_id, environment_id, metric, value, occurred_at)
      VALUES ('e1', 'org_1', 'project_1', 'env_1', 'sfuIngressBytes', 100, '2026-10-01T12:00:00Z'),
      ('e2', 'org_1', 'project_1', 'env_1', 'sfuIngressBytes', 500, '2026-10-08T12:00:00Z'),
      ('e3', 'org_1', 'project_1', 'env_2', 'sfuIngressBytes', 200, '2026-10-02T12:00:00Z'),
      ('e4', 'org_2', 'project_2', 'env_other', 'sfuIngressBytes', 900, '2026-10-02T12:00:00Z'),
      ('e5', 'org_1', 'project_1', 'env_1', 'audioParticipantSeconds', 12, '2026-10-02T12:00:00Z'),
      ('e6', 'org_1', 'project_1', 'env_1', 'videoParticipantSeconds', 8, '2026-10-02T12:00:00Z'),
      ('e7', 'org_1', 'project_1', 'env_1', 'screenShareSeconds', 5, '2026-10-02T12:00:00Z'),
      ('e8', 'org_1', 'project_1', 'env_1', 'screenShareIngressBytes', 40, '2026-10-02T12:00:00Z'),
      ('e9', 'org_1', 'project_1', 'env_1', 'screenShareEgressBytes', 80, '2026-10-02T12:00:00Z')`);
    const result = await getProjectUsage(
      database.db,
      { ...scope, environmentId: "env_1" },
      "7d",
      now,
    );
    expect(result.summary.participantSeconds).toBe(60);
    expect(result.summary.sfuIngressBytes).toBe(100);
    expect(result.summary.audioParticipantSeconds).toBe(12);
    expect(result.summary.videoParticipantSeconds).toBe(8);
    expect(result.summary.screenShareSeconds).toBe(5);
    expect(result.summary.screenShareIngressBytes).toBe(40);
    expect(result.summary.screenShareEgressBytes).toBe(80);
    expect((await getProjectUsage(database.db, scope, "7d", now)).summary.sfuIngressBytes).toBe(
      300,
    );
  });
  it("serves the real usage calculation through Fastify after checking database membership", async () => {
    // The route owns its read-only transactions; publish the fixture before making requests.
    await query("COMMIT");
    fixtureTransaction = false;
    await query(
      `INSERT INTO "user" (id, name, email, updated_at) VALUES ('user_1', 'Test', 'test@example.com', now())`,
    );
    await query(
      `INSERT INTO member (id, organization_id, user_id, role) VALUES ('member_1', 'org_1', 'user_1', 'owner')`,
    );
    const app = Fastify();
    registerErrorHandling(app);
    void app.register(reportingRoutes, {
      database: database.db,
      verifyConsoleSession: (headers) =>
        Promise.resolve(headers.get("cookie") === "test=session" ? { userId: "user_1" } : null),
      prefix: "/v1",
    });
    try {
      const response = await app.inject({
        url: "/v1/projects/project_1/usage?environmentId=env_1",
        headers: { cookie: "test=session" },
      });
      expect(response.statusCode).toBe(200);
      const analytics = await app.inject({
        url: "/v1/projects/project_1/analytics?range=live&environmentId=env_1",
        headers: { cookie: "test=session" },
      });
      expect(analytics.statusCode).toBe(200);
      expect(analytics.json()).toMatchObject({
        scope: { ...scope, environmentId: "env_1" },
        topRooms: [],
        qualityGranularitySeconds: 60,
      });
      expect(response.json()).toMatchObject({
        scope: { ...scope, environmentId: "env_1" },
        summary: { participantSeconds: 0 },
      });
      const denied = await app.inject({
        url: "/v1/projects/project_2/usage",
        headers: { cookie: "test=session" },
      });
      expect(denied.statusCode).toBe(404);
      const organization = await app.inject({
        url: "/v1/organizations/org_1/usage?limit=1",
        headers: { cookie: "test=session" },
      });
      expect(organization.statusCode).toBe(200);
      expect(organization.json()).toMatchObject({
        organizationId: "org_1",
        pagination: { limit: 1, total: 1 },
      });
      const quota = await app.inject({
        url: "/v1/organizations/org_1/quota",
        headers: { cookie: "test=session" },
      });
      expect(quota.statusCode).toBe(200);
      expect(quota.json()).toEqual({ organizationId: "org_1", status: "unconfigured", limits: [] });
      for (const route of ["usage", "quota"]) {
        const deniedOrganization = await app.inject({
          url: `/v1/organizations/org_2/${route}`,
          headers: { cookie: "test=session" },
        });
        expect(deniedOrganization.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
  it("records message deltas once and filters them by occurrence time", async () => {
    await room();
    await session("s1", "p1", "2026-10-08T11:59:00Z");
    await query("UPDATE participant_session SET messages_in = 5, messages_out = 7 WHERE id = 's1'");
    await query("UPDATE participant_session SET messages_in = 5, messages_out = 7 WHERE id = 's1'");
    await query("UPDATE participant_session SET messages_in = 8, messages_out = 9 WHERE id = 's1'");
    const result = await getProjectUsage(database.db, scope, "7d", new Date(Date.now() + 1000));
    expect(result.summary.messagesIn).toBe(8);
    expect(result.summary.messagesOut).toBe(9);
    expect(
      (await query("SELECT * FROM usage_event WHERE metric IN ('messagesIn', 'messagesOut')"))
        .length,
    ).toBe(4);
    await query("UPDATE usage_event SET occurred_at = '2026-09-01T00:00:00Z'");
    expect((await getProjectUsage(database.db, scope, "7d", now)).summary.messagesIn).toBe(0);
  });
  it("keeps bucket boundaries in UTC across daylight-saving changes", async () => {
    await query("SET LOCAL TIME ZONE 'America/New_York'");
    const result = await getProjectUsage(
      database.db,
      scope,
      "30d",
      new Date("2026-11-08T12:00:00Z"),
    );
    for (const bucket of result.buckets) {
      expect(Date.parse(bucket.endedAt) - Date.parse(bucket.startedAt)).toBeLessThanOrEqual(
        86_400_000,
      );
    }
    expect(
      result.buckets.reduce(
        (seconds, bucket) =>
          seconds + (Date.parse(bucket.endedAt) - Date.parse(bucket.startedAt)) / 1000,
        0,
      ),
    ).toBe(30 * 86400);
  });
  it("backfills legacy sessions without inventing reconnect or message history", async () => {
    const admin = createDatabase(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test");
    const databaseName = "relayrtc_session_" + randomUUID().replaceAll("-", "");
    const legacyUrl = new URL(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test");
    legacyUrl.pathname = "/" + databaseName;
    const folder = fileURLToPath(
      new URL("../../../../../packages/database/migrations", import.meta.url),
    );
    let legacy: ReturnType<typeof createDatabase> | undefined;
    let created = false;
    try {
      await admin.client.unsafe(`CREATE DATABASE ${databaseName}`);
      created = true;
      legacy = createDatabase(legacyUrl.toString(), { maxConnections: 1 });
      const journal = JSON.parse(await readFile(`${folder}/meta/_journal.json`, "utf8")) as {
        entries: { idx: number; tag: string }[];
      };
      for (const entry of journal.entries.filter((entry) => entry.idx < 12))
        await legacy.client.unsafe(await readFile(`${folder}/${entry.tag}.sql`, "utf8"));
      await legacy.client.unsafe(`
        INSERT INTO organization(id,name,slug) VALUES('org_1','Legacy','legacy');
        INSERT INTO project(id,organization_id,name,slug) VALUES('project_1','org_1','Legacy','legacy');
        INSERT INTO environment(id,project_id,name,slug,type) VALUES('env_1','project_1','Legacy','legacy','custom');
        INSERT INTO room(id,project_id,environment_id,name,max_participants,status,started_at)
          VALUES('room_1','project_1','env_1','Legacy',4,'active','2026-10-02T10:00:00Z');
        INSERT INTO participant(id,room_id,name,joined_at) VALUES('p1','room_1','Test','2026-10-02T10:00:00Z');
        INSERT INTO participant_session(id,participant_id,signaling_node_id,joined_at,reconnected_at,disconnected_at,
          connection_state,connection_seconds,messages_in)
          VALUES('legacy','p1','node','2026-10-02T10:00:00Z','2026-10-02T10:20:00Z','2026-10-02T10:30:00Z','disconnected',1200,10);
      `);
      // Migrate the actual old schema forward instead of tearing columns out of the current one.
      for (const entry of journal.entries.filter((entry) => entry.idx >= 12))
        await legacy.client.unsafe(await readFile(`${folder}/${entry.tag}.sql`, "utf8"));
      const result = await getProjectUsage(legacy.db, scope, "7d", now);
      expect(result.summary.participantSeconds).toBe(600);
      expect(result.summary.messagesIn).toBe(0);
      expect(result.dataQuality).toEqual({
        sessionHistory: "partial",
        messageHistory: "partial",
        turnTraffic: "unavailable",
      });
      expect(
        (
          await legacy.client.unsafe(
            "SELECT connection_seconds,messages_in FROM participant_session WHERE id='legacy'",
          )
        )[0],
      ).toMatchObject({ connection_seconds: 1200, messages_in: 10 });
    } finally {
      await legacy?.close();
      if (created) await admin.client.unsafe(`DROP DATABASE ${databaseName}`);
      await admin.close();
    }
  }, 30_000);
});
