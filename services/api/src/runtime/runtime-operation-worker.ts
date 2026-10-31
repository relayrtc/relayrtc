import {
  processRuntimeOperation,
  reconcileRuntimeOperations,
  type RoomTerminationConfig,
} from "@relayrtc/auth";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

export function registerRuntimeOperationWorker(
  app: FastifyInstance,
  database: RelayKitDatabase,
  config: RoomTerminationConfig,
) {
  const shutdown = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let reconciledAt = 0;
  const run = async () => {
    try {
      await database.execute(sql`DELETE FROM room_speaker_snapshot WHERE room_id IN(
        SELECT room_id FROM room_speaker_snapshot WHERE observed_at<now()-interval '30 seconds' ORDER BY observed_at LIMIT 1000)`);
      await database.transaction(async transaction => {
        await transaction.execute(sql`SET LOCAL lock_timeout='2s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout='5s'`);
        await transaction.execute(sql`WITH due AS MATERIALIZED (
          SELECT r.id FROM room r JOIN room_lifecycle l ON l.room_id=r.id
          WHERE r.status IN ('created','active') AND l.ends_at<=now() AND l.settled_at IS NULL
          ORDER BY l.ends_at LIMIT 25 FOR UPDATE OF r SKIP LOCKED
        ) UPDATE room SET status='ended',ended_at=now() WHERE id IN(SELECT id FROM due)`);
      });
      if (Date.now() - reconciledAt >= 30_000) {
        await reconcileRuntimeOperations(database);
        reconciledAt = Date.now();
      }
      for (let index = 0; index < 25 && !shutdown.signal.aborted; index++) {
        const operation = await processRuntimeOperation(
          database,
          config,
          undefined,
          shutdown.signal,
        );
        if (!operation) break;
        if (operation.status === "failed")
          app.log.warn(
            { operationId: operation.id, attempts: operation.attempts },
            "Runtime cleanup will retry",
          );
      }
    } catch {
      if (!shutdown.signal.aborted)
        app.log.error("Runtime operation worker could not reach its store; retrying");
    }
    if (!shutdown.signal.aborted)
      timer = setTimeout(() => {
        pending = run();
      }, 1_000).unref();
  };
  app.addHook("onReady", (done) => {
    pending = run();
    done();
  });
  return async () => {
    shutdown.abort();
    clearTimeout(timer);
    await pending;
  };
}
