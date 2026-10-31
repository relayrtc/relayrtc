import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@relayrtc/database";
import { createRelayKitSessionVerifier } from "@relayrtc/auth/server";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOrganizationUsage } from "./organization-usage.service.js";
import { getProjectAnalytics } from "./project-analytics.service.js";
import { reportingRoutes } from "./reporting.routes.js";
import { registerErrorHandling } from "../../http/errors/error-handler.js";
import { refreshUsageAggregates } from "./usage-aggregation.service.js";
import { expireUsageHistory } from "./usage-retention.service.js";

const databaseUrl = process.env.RELAYRTC_TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/relayrtc_usage_test")
  throw new Error("A dedicated relayrtc_usage_test database is required");
const secret = "retention-test-session-secret-at-least-32-characters";
const cookie = `better-auth.session_token=${encodeURIComponent("retained-token." + createHmac("sha256", secret).update("retained-token").digest("base64"))}`;
const migrationFolder = fileURLToPath(
  new URL("../../../../../packages/database/migrations", import.meta.url),
);
const fixture = `
  INSERT INTO organization (id, name, slug) VALUES ('org_retained', 'Retained', 'retained'), ('org_retained_other', 'Other', 'retained-other');
  INSERT INTO project (id, organization_id, name, slug) VALUES ('project_retained', 'org_retained', 'Private project name', 'retained');
  INSERT INTO environment (id, project_id, name, slug, type) VALUES ('env_retained', 'project_retained', 'Private environment name', 'retained', 'custom');
  INSERT INTO room (id, project_id, environment_id, name, max_participants, status, created_at, started_at, ended_at)
    VALUES ('room_retained', 'project_retained', 'env_retained', 'Private room name', 10, 'active', now() - interval '1 hour', now() - interval '1 hour', NULL);
  INSERT INTO participant (id, room_id, name, external_id, metadata, joined_at, left_at)
    VALUES ('participant_retained', 'room_retained', 'Private participant name', 'private@example.com', '{"private":"secret"}', now() - interval '10 minutes', now() - interval '2 minutes');
  INSERT INTO participant_session (id, participant_id, signaling_node_id, client_ip, country, joined_at, metering_started_at)
    VALUES ('session_retained', 'participant_retained', 'node_retained', '192.0.2.123', 'Japan', now() - interval '10 minutes', now() - interval '10 minutes');
  UPDATE participant_session SET connection_state = 'reconnecting', disconnected_at = now() - interval '9 minutes', messages_in = 3, messages_out = 5 WHERE id = 'session_retained';
  UPDATE participant_session SET connection_state = 'connected', disconnected_at = NULL, reconnected_at = now() - interval '8 minutes' WHERE id = 'session_retained';
  UPDATE participant_session SET connection_state = 'disconnected', disconnected_at = now() - interval '7 minutes' WHERE id = 'session_retained';
  UPDATE room SET status = 'ended', ended_at = now() - interval '2 minutes' WHERE id = 'room_retained';
  INSERT INTO usage_event (id, organization_id, project_id, environment_id, room_id, metric, value, occurred_at)
    VALUES ('event_retained', 'org_retained', 'project_retained', 'env_retained', 'room_retained', 'sfuIngressBytes', 1.25, now() - interval '1 minute');
`;

describe.skipIf(!databaseUrl)("retained accounting history against PostgreSQL", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test", {
    maxConnections: 1,
  });
  const query = (statement: string) => database.client.unsafe(statement);
  const app = Fastify();
  let endedAt: Date;
  let cleanupStatements: string[];
  const cleanup = () =>
    database.client.begin(async (transaction) => {
      for (const statement of cleanupStatements)
        await transaction.unsafe(statement, [["org_retained", "org_retained_other"]]);
      await transaction.unsafe(`DELETE FROM "user" WHERE id='user_retained'`);
    });
  const report = () =>
    getOrganizationUsage(
      database.db,
      "org_retained",
      { range: "7d", limit: 50, offset: 0 },
      endedAt,
    );
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: migrationFolder });
    cleanupStatements = (
      await readFile(new URL("../../../../../tests/reporting-cleanup.sql", import.meta.url), "utf8")
    ).split("--> statement-breakpoint");
    registerErrorHandling(app);
    await app.register(reportingRoutes, {
      database: database.db,
      prefix: "/v1",
      verifyConsoleSession: createRelayKitSessionVerifier({
        database: database.db,
        baseUrl: "http://localhost:3002",
        secret,
      }),
    });
    await app.ready();
  }, 30_000);
  beforeEach(async () => {
    await cleanup();
    await query(fixture);
    await query(`INSERT INTO "user" (id, name, email, updated_at) VALUES ('user_retained', 'Owner', 'retained@example.com', now());
      INSERT INTO member (id, organization_id, user_id, role) VALUES ('member_retained', 'org_retained', 'user_retained', 'owner');
      INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ('auth_retained', 'retained-token', 'user_retained', now() + interval '1 day', now());`);
    endedAt = new Date(Date.now() + 1000);
    await refreshUsageAggregates(
      database.db,
      "org_retained",
      new Date(endedAt.getTime() - 86400_000),
      endedAt,
    );
  });
  afterEach(async () => {
    await query("ROLLBACK");
    await cleanup();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it.each(["room", "environment", "project", "organization"])(
    "preserves populated history when deleting a %s",
    async (level) => {
      const before = await report();
      expect(before.summary.participantSeconds).toBe(120);
      expect(before.summary.messagesIn).toBe(3);
      const [totals] = await query(
        "SELECT count(*) AS count, sum(value) AS value FROM usage_event WHERE organization_id = 'org_retained'",
      );
      const aggregates = await query(
        "SELECT * FROM usage_aggregate WHERE organization_id = 'org_retained' ORDER BY id",
      );
      const ids: Record<string, string> = {
        room: "room_retained",
        environment: "env_retained",
        project: "project_retained",
        organization: "org_retained",
      };
      const id = ids[level];
      if (!id) throw new Error("Unsupported deletion level");
      await database.client.unsafe(`DELETE FROM ${level} WHERE id = $1`, [id]);
      expect((await report()).summary).toEqual(before.summary);
      expect(
        await query(
          "SELECT count(*) AS count, sum(value) AS value FROM usage_event WHERE organization_id = 'org_retained'",
        ),
      ).toEqual([totals]);
      expect(
        await query(
          "SELECT * FROM usage_aggregate WHERE organization_id = 'org_retained' ORDER BY id",
        ),
      ).toEqual(aggregates);
      expect(
        await query("SELECT * FROM participant_session WHERE id = 'session_retained'"),
      ).toEqual([]);
      expect(
        (await query("SELECT * FROM usage_history_interval WHERE session_id = 'session_retained'"))
          .length,
      ).toBe(2);
      const organizationResponse = await app.inject({
        url: "/v1/organizations/org_retained/usage",
        headers: { cookie },
      });
      expect(organizationResponse.statusCode).toBe(level === "organization" ? 404 : 200);
      const projectResponse = await app.inject({
        url: "/v1/projects/project_retained/usage",
        headers: { cookie },
      });
      expect(projectResponse.statusCode).toBe(
        ["organization", "project"].includes(level) ? 404 : 200,
      );
      expect(
        (
          await app.inject({
            url: "/v1/organizations/org_retained_other/usage",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
      if (level === "environment") {
        expect(
          (
            await app.inject({
              url: "/v1/projects/project_retained/usage?environmentId=env_retained",
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(404);
      }
      if (!["organization", "project"].includes(level)) {
        const analytics = await getProjectAnalytics(
          database.db,
          { organizationId: "org_retained", projectId: "project_retained", environmentId: null },
          "7d",
          endedAt,
        );
        expect(analytics.topRooms[0]).toMatchObject({
          id: "room_retained",
          name: "room_retained",
          participants: 1,
          participantSeconds: 120,
        });
        expect(analytics.regions).toEqual([{ name: "Japan", sessions: 1 }]);
      }
      await database.client.unsafe(`DELETE FROM ${level} WHERE id = $1`, [id]);
      expect((await report()).summary).toEqual(before.summary);
    },
  );

  it("closes live intervals at deletion instead of continuing to accrue usage", async () => {
    await query(`UPDATE room SET status = 'active', ended_at = NULL WHERE id = 'room_retained';
      UPDATE participant SET left_at = NULL WHERE id = 'participant_retained';
      UPDATE participant_session SET connection_state = 'connected', disconnected_at = NULL, reconnected_at = now() - interval '1 minute' WHERE id = 'session_retained';
      DELETE FROM room WHERE id = 'room_retained';`);
    expect(
      await query(
        "SELECT id FROM usage_history_interval WHERE session_id = 'session_retained' AND ended_at IS NULL",
      ),
    ).toEqual([]);
    const now = new Date(Date.now() + 1000);
    const later = new Date(now.getTime() + 3600_000);
    const options = { range: "7d" as const, limit: 50, offset: 0 };
    expect(
      (await getOrganizationUsage(database.db, "org_retained", options, later)).summary,
    ).toEqual((await getOrganizationUsage(database.db, "org_retained", options, now)).summary);
  });

  it("rolls back deletion without changing retained records or totals", async () => {
    const before = await report();
    await query(
      "BEGIN; SAVEPOINT deletion; DELETE FROM project WHERE id = 'project_retained'; ROLLBACK TO SAVEPOINT deletion",
    );
    expect((await report()).summary).toEqual(before.summary);
    expect(
      (await query("SELECT deleted_at FROM usage_history_project WHERE id = 'project_retained'"))[0]
        ?.deleted_at,
    ).toBeNull();
    expect(
      (await query("SELECT id FROM participant_session WHERE id = 'session_retained'")).length,
    ).toBe(1);
  });

  it("rejects reassignment and mismatched accounting scopes", async () => {
    await query("BEGIN; SAVEPOINT invalid_scope");
    await expect(
      query(
        "UPDATE project SET organization_id = 'org_retained_other' WHERE id = 'project_retained'",
      ),
    ).rejects.toThrow("immutable");
    await query("ROLLBACK TO SAVEPOINT invalid_scope");
    await expect(
      query(
        "UPDATE usage_event SET organization_id = 'org_retained_other' WHERE id = 'event_retained'",
      ),
    ).rejects.toThrow("Invalid accounting usage scope");
    await query("ROLLBACK TO SAVEPOINT invalid_scope");
    await query("DELETE FROM project WHERE id = 'project_retained'");
    await expect(
      query(
        "INSERT INTO project (id, organization_id, name, slug) VALUES ('project_retained', 'org_retained_other', 'Reused', 'reused')",
      ),
    ).rejects.toThrow("duplicate key");
    await query("ROLLBACK TO SAVEPOINT invalid_scope");
  });

  it("retains no participant names, addresses, metadata, room names or IP addresses", async () => {
    await query("DELETE FROM organization WHERE id = 'org_retained'");
    const rows = await query(
      "SELECT row_to_json(s) AS data FROM usage_history_session s WHERE id = 'session_retained'",
    );
    const rooms = await query(
      "SELECT row_to_json(r) AS data FROM usage_history_room r WHERE id = 'room_retained'",
    );
    const text = JSON.stringify([rows, rooms]);
    for (const privateValue of [
      "private@example.com",
      "Private participant name",
      "192.0.2.123",
      "Private room name",
      "secret",
    ])
      expect(text).not.toContain(privateValue);
  });

  it("expires old closed history and leaves current activity and other tenants intact", async () => {
    const cutoff = new Date(endedAt.getTime() - 365 * 86400_000);
    // Raw samples retain the boundary hour, and rollups retain the boundary month.
    const expiredAt = new Date(cutoff);
    expiredAt.setUTCMonth(expiredAt.getUTCMonth() - 2, 1);
    expiredAt.setUTCHours(0, 0, 0, 0);
    await query("DELETE FROM organization WHERE id = 'org_retained'");
    for (const statement of [
      "UPDATE usage_event SET occurred_at = $1 WHERE organization_id = 'org_retained'",
      "UPDATE usage_lifecycle_event SET occurred_at = $1 WHERE organization_id = 'org_retained'",
      "UPDATE usage_history_project SET deleted_at = $1 WHERE id = 'project_retained'",
      "UPDATE usage_history_organization SET deleted_at = $1 WHERE id = 'org_retained'",
      "UPDATE usage_history_environment SET deleted_at = $1 WHERE id = 'env_retained'",
      "UPDATE usage_history_room SET ended_at = $1, deleted_at = $1 WHERE id = 'room_retained'",
      "UPDATE usage_history_session SET left_at = $1, deleted_at = $1 WHERE id = 'session_retained'",
    ])
      await database.client.unsafe(statement, [expiredAt.toISOString()]);
    // Preserve distinct canonical bucket keys when moving all rollups before the cutoff month.
    await query(`UPDATE usage_aggregate SET window_started_at=window_started_at-interval '2 years',
      window_ended_at=window_ended_at-interval '2 years' WHERE organization_id='org_retained'`);
    await query(`INSERT INTO project (id, organization_id, name, slug) VALUES ('project_retained_live', 'org_retained_other', 'Live', 'live');
      INSERT INTO environment (id, project_id, name, slug, type) VALUES ('env_retained_live', 'project_retained_live', 'Live', 'live', 'custom');
      INSERT INTO room (id, project_id, environment_id, name, max_participants, status, created_at, started_at) VALUES ('room_retained_live', 'project_retained_live', 'env_retained_live', 'Live', 10, 'active', now() - interval '2 years', now() - interval '2 years');
      INSERT INTO participant (id, room_id, name, joined_at) VALUES ('participant_retained_live', 'room_retained_live', 'Live', now() - interval '2 years');
      INSERT INTO participant_session (id, participant_id, signaling_node_id, joined_at, metering_started_at) VALUES ('session_retained_live', 'participant_retained_live', 'node', now() - interval '2 years', now() - interval '2 years');`);
    await database.client.unsafe(
      `INSERT INTO usage_event (id, organization_id, project_id, environment_id, metric, value, occurred_at) VALUES ('retained_boundary', 'org_retained_other', 'project_retained_live', 'env_retained_live', 'messagesIn', 1, $1)`,
      [cutoff.toISOString()],
    );
    const boundaryHour = new Date(cutoff);
    boundaryHour.setUTCMinutes(0, 0, 0);
    await database.client.unsafe(
      `INSERT INTO usage_event(id,organization_id,project_id,environment_id,metric,value,occurred_at)
        VALUES('retained_boundary_hour','org_retained_other','project_retained_live','env_retained_live','messagesIn',1,$1)`,
      [boundaryHour.toISOString()],
    );
    expect((await expireUsageHistory(database.db, 365, endedAt)).status).toBe("expired");
    for (const table of [
      "usage_event",
      "usage_aggregate",
      "usage_history_project",
      "usage_history_room",
    ])
      expect(await query(`SELECT * FROM ${table} WHERE organization_id = 'org_retained'`)).toEqual(
        [],
      );
    expect(
      await query("SELECT * FROM usage_history_environment WHERE id = 'env_retained'"),
    ).toEqual([]);
    expect(
      await query("SELECT * FROM usage_history_organization WHERE id = 'org_retained'"),
    ).toEqual([]);
    expect(
      await query("SELECT * FROM usage_history_session WHERE id = 'session_retained'"),
    ).toEqual([]);
    expect(
      await query("SELECT * FROM usage_history_interval WHERE session_id = 'session_retained'"),
    ).toEqual([]);
    expect(
      (await query("SELECT id FROM usage_history_session WHERE id = 'session_retained_live'"))
        .length,
    ).toBe(1);
    expect((await query("SELECT id FROM usage_event WHERE id = 'retained_boundary'")).length).toBe(
      1,
    );
    expect(
      (await query("SELECT id FROM usage_event WHERE id = 'retained_boundary_hour'")).length,
    ).toBe(1);
    expect(await expireUsageHistory(database.db, 365, endedAt)).toEqual({
      status: "expired",
      cutoff: cutoff.toISOString(),
    });
  });
});

describe.skipIf(!databaseUrl)("populated retained-history migration rehearsal", () => {
  it("backfills without loss and supports transactional rollback before committing", async () => {
    const admin = createDatabase(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test");
    const rehearsalUrl = new URL(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test");
    const databaseName = "relayrtc_history_" + randomUUID().replaceAll("-", "");
    rehearsalUrl.pathname = "/" + databaseName;
    let rehearsal: ReturnType<typeof createDatabase> | undefined;
    let created = false;
    try {
      await admin.client.unsafe(`CREATE DATABASE ${databaseName}`);
      created = true;
      rehearsal = createDatabase(rehearsalUrl.toString(), { maxConnections: 1 });
      const journal = JSON.parse(
        await readFile(`${migrationFolder}/meta/_journal.json`, "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      for (const entry of journal.entries.filter((entry) => entry.idx < 14))
        await rehearsal.client.unsafe(
          await readFile(`${migrationFolder}/${entry.tag}.sql`, "utf8"),
        );
      await rehearsal.client.unsafe(fixture);
      await rehearsal.client
        .unsafe(`INSERT INTO usage_aggregate (id, organization_id, project_id, environment_id, granularity, window_started_at, window_ended_at, metrics)
        VALUES ('aggregate_retained', 'org_retained', 'project_retained', 'env_retained', 'hour', now() - interval '1 hour', now(), '{"sfuIngressBytes":1.25}');
        UPDATE participant_session SET metering_started_at = joined_at + interval '1 minute' WHERE id = 'session_retained';`);
      const counts = await rehearsal.client.unsafe(
        "SELECT (SELECT count(*) FROM usage_event) AS events, (SELECT sum(value) FROM usage_event) AS value, (SELECT count(*) FROM participant_connection_interval) AS intervals, (SELECT count(*) FROM usage_aggregate) AS aggregates",
      );
      const migration = await readFile(
        `${migrationFolder}/0014_retained_usage_history.sql`,
        "utf8",
      );
      await rehearsal.client.unsafe("BEGIN");
      await rehearsal.client.unsafe(migration);
      await rehearsal.client.unsafe("ROLLBACK");
      expect(
        (await rehearsal.client.unsafe("SELECT to_regclass('usage_history_session') AS name"))[0]
          ?.name,
      ).toBeNull();
      await rehearsal.client.unsafe("BEGIN");
      await rehearsal.client.unsafe(migration);
      await rehearsal.client.unsafe("COMMIT");
      expect(
        await rehearsal.client.unsafe(
          "SELECT (SELECT count(*) FROM usage_event) AS events, (SELECT sum(value) FROM usage_event) AS value, (SELECT count(*) FROM usage_history_interval) AS intervals, (SELECT count(*) FROM usage_aggregate) AS aggregates",
        ),
      ).toEqual(counts);
      // Current reporting also reads lifecycle, TURN and service journals added after 0014.
      for (const entry of journal.entries.filter((entry) => entry.idx > 14))
        await rehearsal.client.unsafe(
          await readFile(`${migrationFolder}/${entry.tag}.sql`, "utf8"),
        );
      const options = { range: "7d" as const, limit: 50, offset: 0 };
      const end = new Date(Date.now() + 1000);
      const before = await getOrganizationUsage(rehearsal.db, "org_retained", options, end);
      expect(before.summary.participantSeconds).toBeCloseTo(120, 0);
      expect(before.dataQuality).toEqual({
        sessionHistory: "partial",
        messageHistory: "partial",
        turnTraffic: "unavailable",
      });
      await rehearsal.client.unsafe("DELETE FROM organization WHERE id = 'org_retained'");
      expect(
        (await getOrganizationUsage(rehearsal.db, "org_retained", options, end)).summary,
      ).toEqual(before.summary);
    } finally {
      await rehearsal?.close();
      if (created) await admin.client.unsafe(`DROP DATABASE ${databaseName}`);
      await admin.close();
    }
  }, 30_000);
});
