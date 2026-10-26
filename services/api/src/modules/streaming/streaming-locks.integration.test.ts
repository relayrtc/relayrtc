import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDatabase, schema } from "@relayrtc/database";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stopSessions } from "./lifecycle.js";
import { getStream, type Transaction } from "./repository.js";

const databaseUrl = process.env.RELAYRTC_TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/relayrtc_usage_test") {
  throw new Error("A dedicated relayrtc_usage_test database is required");
}

function gate() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

describe.skipIf(!databaseUrl)("stream management concurrent with source accounting", () => {
  const database = createDatabase(databaseUrl ?? "postgresql://localhost/relayrtc_usage_test", {
    maxConnections: 4,
  });
  let ownerId: string;
  let streamId: string;
  let sessionId: string;
  let credentialId: string;

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../../../packages/database/migrations", import.meta.url),
      ),
    });
  }, 30_000);

  beforeEach(async () => {
    const suffix = randomUUID();
    ownerId = `lock_owner_${suffix}`;
    streamId = `stream_${suffix}`;
    sessionId = `source_${suffix}`;
    credentialId = `ingest_${suffix}`;
    await database.db.execute(sql`
      INSERT INTO organization(id,name,slug) VALUES(${ownerId},'Lock rehearsal',${ownerId});
    `);
    await database.db.execute(sql`
      INSERT INTO project(id,organization_id,name,slug) VALUES(${ownerId},${ownerId},'Lock rehearsal','locks');
    `);
    await database.db.execute(sql`
      INSERT INTO environment(id,project_id,name,slug,type) VALUES(${ownerId},${ownerId},'Lock rehearsal','locks','custom');
    `);
    await database.db.insert(schema.streamingStream).values({
      id: streamId,
      organizationId: ownerId,
      projectId: ownerId,
      environmentId: ownerId,
      name: "Concurrent stream",
      source: { kind: "whip" },
      profile: {
        audioOnly: false,
        width: 640,
        height: 360,
        fps: 15,
        videoBitrate: 600000,
        audioBitrate: 64000,
        layout: "single",
      },
      maxDurationSeconds: 600,
      retentionSeconds: 600,
    });
    await database.db.insert(schema.streamingIngestCredential).values({
      id: credentialId,
      streamId,
      secretHash: suffix,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await database.db.insert(schema.streamingSession).values({
      id: sessionId,
      streamId,
      ingressCredentialId: credentialId,
      state: "live",
      generation: 1,
    });
  });

  afterEach(async () => {
    // Remove children before the owner, whose deletion intentionally retains accounting history.
    await database.db.execute(sql`DELETE FROM streaming_usage_sample WHERE stream_id=${streamId}`);
    await database.db
      .delete(schema.streamingSession)
      .where(eq(schema.streamingSession.id, sessionId));
    await database.db
      .delete(schema.streamingIngestCredential)
      .where(eq(schema.streamingIngestCredential.id, credentialId));
    await database.db.delete(schema.streamingStream).where(eq(schema.streamingStream.id, streamId));
    await database.db.execute(sql`DELETE FROM organization WHERE id=${ownerId}`);
    await database.db.execute(sql`DELETE FROM usage_history_environment WHERE id=${ownerId}`);
    await database.db.execute(sql`DELETE FROM usage_history_project WHERE id=${ownerId}`);
    await database.db.execute(sql`DELETE FROM usage_history_organization WHERE id=${ownerId}`);
  });

  afterAll(async () => {
    await database.close();
  });

  async function backendPid(db: Transaction) {
    await db.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [row] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    if (!row) throw new Error("Missing database backend");
    return row.pid;
  }

  async function waitForBlock(waiter: number, blocker: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await database.db.execute<{ blocked: boolean }>(
        sql`SELECT ${blocker}::int=ANY(pg_blocking_pids(${waiter}::int)) AS blocked`,
      );
      if (row?.blocked) return;
      await delay(10);
    }
    throw new Error("The concurrent management request did not reach the expected database lock");
  }

  it.each(["stop", "delete", "rotate"] as const)(
    "allows a heartbeat sample to commit while %s waits for its session",
    async (command) => {
      const workerLocked = gate(),
        managementLocked = gate(),
        insertSample = gate();
      let workerPid = 0,
        managementPid = 0;
      const heartbeat = database.db.transaction(async (db) => {
        workerPid = await backendPid(db);
        await db
          .select()
          .from(schema.streamingSession)
          .where(eq(schema.streamingSession.id, sessionId))
          .for("update");
        workerLocked.open();
        await insertSample.ready;
        // Real foreign keys require KEY SHARE locks on both the session and its stream.
        await db.execute(sql`
        INSERT INTO streaming_usage_sample(session_id,generation,sequence,stream_id,organization_id,project_id,environment_id,
          start_at,end_at,source_seconds,ingress_bytes,program_bytes,coverage)
        VALUES(${sessionId},1,1,${streamId},${ownerId},${ownerId},${ownerId},now(),now(),0,1,1,'observed')
      `);
      });
      // Attach rejection handlers before releasing either transaction.
      void heartbeat.catch(() => undefined);
      await Promise.race([workerLocked.ready, heartbeat]);
      const management = database.db.transaction(async (db) => {
        managementPid = await backendPid(db);
        await getStream(db, streamId, true);
        managementLocked.open();
        const stopped = await stopSessions(
          db,
          streamId,
          command === "rotate" ? credentialId : undefined,
        );
        if (command === "delete") {
          await db
            .update(schema.streamingStream)
            .set({ status: "deleting" })
            .where(eq(schema.streamingStream.id, streamId));
        }
        return stopped;
      });
      void management.catch(() => undefined);
      let results: Awaited<ReturnType<typeof Promise.allSettled>>;
      try {
        await Promise.race([managementLocked.ready, management]);
        // Observe the actual row wait instead of depending on a timing-based overlap.
        await waitForBlock(managementPid, workerPid);
      } finally {
        insertSample.open();
        results = await Promise.allSettled([heartbeat, management]);
      }
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
      expect(results[1]).toMatchObject({ status: "fulfilled", value: sessionId });
      const [session] = await database.db
        .select()
        .from(schema.streamingSession)
        .where(eq(schema.streamingSession.id, sessionId));
      expect(session).toMatchObject({
        desiredState: "stopped",
        state: "stopping",
        lastError: command === "rotate" ? "INGEST_CREDENTIAL_ROTATED" : null,
      });
      const samples = await database.db.execute(
        sql`SELECT sequence FROM streaming_usage_sample WHERE session_id=${sessionId}`,
      );
      expect(samples).toHaveLength(1);
      const stream = await database.db.transaction((db) => getStream(db, streamId));
      expect(stream.status).toBe(command === "delete" ? "deleting" : "active");
    },
    15_000,
  );

  it("still serializes competing stream changes without losing a version update", async () => {
    const firstLocked = gate(),
      releaseFirst = gate(),
      secondStarted = gate();
    let firstPid = 0,
      secondPid = 0;
    const first = database.db.transaction(async (db) => {
      firstPid = await backendPid(db);
      const stream = await getStream(db, streamId, true);
      firstLocked.open();
      await releaseFirst.ready;
      await db
        .update(schema.streamingStream)
        .set({ version: stream.version + 1 })
        .where(eq(schema.streamingStream.id, streamId));
    });
    void first.catch(() => undefined);
    await Promise.race([firstLocked.ready, first]);
    const second = database.db.transaction(async (db) => {
      secondPid = await backendPid(db);
      secondStarted.open();
      const stream = await getStream(db, streamId, true);
      await db
        .update(schema.streamingStream)
        .set({ version: stream.version + 1 })
        .where(eq(schema.streamingStream.id, streamId));
    });
    void second.catch(() => undefined);
    try {
      await Promise.race([secondStarted.ready, second]);
      await waitForBlock(secondPid, firstPid);
    } finally {
      releaseFirst.open();
      await Promise.all([first, second]);
    }
    const stream = await database.db.transaction((db) => getStream(db, streamId));
    expect(stream.version).toBe(3);
  }, 15_000);
});
