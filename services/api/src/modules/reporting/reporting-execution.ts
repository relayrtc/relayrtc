import type { RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";

export type ReportingDatabase = Pick<RelayKitDatabase, "execute">;

/** Per-route-instance, bounded cache; callers must authorize every request first. */
export function createReportReader(database: RelayKitDatabase) {
  const cache = new Map<string, { expiresAt: number; result: Promise<unknown> }>();
  return <T>(key: string, load: (db: ReportingDatabase) => Promise<T>): Promise<T> => {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result as Promise<T>;
    const oldest = cache.keys().next().value;
    if (cache.size >= 32 && oldest !== undefined) cache.delete(oldest);
    const entry = { expiresAt: Infinity, result: Promise.resolve<unknown>(undefined) };
    const result = database.transaction(async (tx) => {
      // Journal reports have very different plans from transactional requests.
      // Keep settings inside this read-only transaction and bound query runtime.
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL jit = off`);
      // JSON/range cardinality estimates otherwise cause oversized hash plans.
      await tx.execute(sql`SET LOCAL enable_hashagg = off`);
      await tx.execute(sql`SET LOCAL enable_memoize = off`);
      await tx.execute(sql`SET LOCAL work_mem = '16MB'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
      return load(tx);
    });
    entry.result = result;
    cache.set(key, entry);
    void result.then(
      () => {
        entry.expiresAt = Date.now() + 15000;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    return result;
  };
}
