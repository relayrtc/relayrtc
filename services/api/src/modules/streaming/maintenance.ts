import type { RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Transaction } from "./repository.js";

export type MaintenanceRunner = {
  (resource: string, work: () => Promise<void>): Promise<void>;
  available(resource: string): boolean;
};

export function createMaintenanceRunner(app: FastifyInstance): MaintenanceRunner {
  const failures = new Map<string, { attempts: number; availableAt: number }>();
  const run = async (resource: string, work: () => Promise<void>) => {
    const previous = failures.get(resource);
    if (previous && previous.availableAt > Date.now()) return;
    try {
      await work();
      failures.delete(resource);
    } catch (error) {
      const attempts = Math.min((previous?.attempts ?? 0) + 1, 6);
      const retryAfterMs = Math.min(60000, 3000 * 2 ** (attempts - 1));
      if (failures.size >= 2048 && !failures.has(resource)) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      failures.set(resource, { attempts, availableAt: Date.now() + retryAfterMs });
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z0-9_]{2,64}$/u.test(error.code)
          ? error.code
          : undefined;
      app.log.error({ resource, attempts, retryAfterMs, code }, "Streaming maintenance will retry");
    }
  };
  return Object.assign(run, {
    available: (resource: string) => (failures.get(resource)?.availableAt ?? 0) <= Date.now(),
  });
}

export async function maintenanceTransaction<T>(
  database: RelayKitDatabase,
  resource: string,
  work: (db: Transaction) => Promise<T>,
) {
  return boundedMaintenanceTransaction(database, async (db) => {
    const [lock] = await db.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${resource},810039)) AS acquired`,
    );
    if (lock?.acquired) return work(db);
    return undefined;
  });
}

export async function boundedMaintenanceTransaction<T>(
  database: RelayKitDatabase,
  work: (db: Transaction) => Promise<T>,
) {
  return database.transaction(async (db) => {
    await db.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await db.execute(sql`SET LOCAL statement_timeout = '10s'`);
    return work(db);
  });
}

export async function maintenanceBatch<T>(rows: T[], work: (row: T) => Promise<void>) {
  for (let index = 0; index < rows.length; index += 3)
    await Promise.all(rows.slice(index, index + 3).map(work));
}
