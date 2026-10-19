import type { RelayKitDatabase } from "@relayrtc/database";
import type { FastifyInstance } from "fastify";
import { collectTurnAllocationLogs, reconcileTurnAllocations } from "./turn-allocation.service.js";
import {
  cancelRetiredTurnAllocations,
  retireTurnCredentials,
  type TurnAllocationControl,
} from "./turn-allocation-control.js";

export function registerTurnAllocationCollector(
  app: FastifyInstance,
  database: RelayKitDatabase,
  directory: string,
  metricsUrl?: string,
  control?: TurnAllocationControl,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let lastReconciled = 0;
  const run = async () => {
    try {
      await retireTurnCredentials(database);
      if (control) await cancelRetiredTurnAllocations(database, directory, control);
    } catch (error) {
      app.log.error({ err: error }, "TURN credential retirement failed; retry scheduled");
    }
    try {
      const result = await collectTurnAllocationLogs(database, directory);
      if (result.caughtUp && metricsUrl && Date.now() - lastReconciled >= 30000) {
        const snapshot = await reconcileTurnAllocations(database, directory, metricsUrl);
        lastReconciled = Date.now();
        const log =
          snapshot.status === "different" ? app.log.warn.bind(app.log) : app.log.info.bind(app.log);
        log(
          { turnAccounting: snapshot, collectedFiles: result.files },
          "TURN accounting reconciliation",
        );
      }
    } catch (error) {
      app.log.error(
        { err: error },
        "TURN accounting collection failed; checkpoint retained for retry",
      );
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          pending = run();
        }, 1000);
        timer.unref();
      }
    }
  };
  app.addHook("onReady", (done) => {
    pending = run();
    done();
  });
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
