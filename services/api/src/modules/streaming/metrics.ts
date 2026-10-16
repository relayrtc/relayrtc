import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { RelayKitDatabase } from "@relayrtc/database";
import { equalSecret } from "./runtime-routes.js";
import type { StreamingConfig } from "./config.js";

/** Private aggregate metrics; no tenant IDs, source names, grants or URLs are exported. */
export const streamingMetricsRoutes: FastifyPluginAsync<{
  database: RelayKitDatabase;
  config: StreamingConfig;
}> = (app, { database, config }) => {
  app.get("/internal/v1/streaming/metrics", async (request, reply) => {
    const token = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!equalSecret(token, config.workerKey)) return reply.code(401).send();
    const [counts] = await database.execute(sql`SELECT
      count(*) FILTER (WHERE state='live')::int AS live,
      count(*) FILTER (WHERE state='starting')::int AS starting,
      count(*) FILTER (WHERE state='reconnecting')::int AS reconnecting,
      count(*) FILTER (WHERE state='stopping')::int AS stopping,
      count(*) FILTER (WHERE state='failed')::int AS failed,
      count(*) FILTER (WHERE leased_until<now() AND state NOT IN ('ended','failed'))::int AS expired,
      coalesce(max(extract(epoch from now()-available_at)) FILTER (WHERE worker_id IS NULL AND state IN ('starting','reconnecting')),0)::float8 AS delay
      FROM streaming_session`);
    const [objects] = await database.execute(sql`SELECT
      count(*) FILTER (WHERE committed_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE expires_at<now())::int AS expired,
      coalesce(sum(size_bytes) FILTER (WHERE committed_at IS NOT NULL),0)::float8 AS bytes FROM streaming_object`);
    const [operations] =
      await database.execute(sql`SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='failed')::int AS failed FROM streaming_operation`);
    const lines = ["live", "starting", "reconnecting", "stopping", "failed"].map(
      (state) =>
        `relayrtc_streaming_sessions{state="${state}"} ${String(Number(counts?.[state] ?? 0))}`,
    );
    lines.push(
      `relayrtc_streaming_expired_leases ${String(Number(counts?.expired ?? 0))}`,
      `relayrtc_streaming_queue_delay_seconds ${String(Number(counts?.delay ?? 0))}`,
      `relayrtc_streaming_pending_uploads ${String(Number(objects?.pending ?? 0))}`,
      `relayrtc_streaming_expired_objects ${String(Number(objects?.expired ?? 0))}`,
      `relayrtc_streaming_stored_bytes ${String(Number(objects?.bytes ?? 0))}`,
      `relayrtc_streaming_pending_operations ${String(Number(operations?.pending ?? 0))}`,
      `relayrtc_streaming_failed_operations ${String(Number(operations?.failed ?? 0))}`,
    );
    return reply
      .header("cache-control", "no-store")
      .type("text/plain; version=0.0.4")
      .send(lines.join("\n") + "\n");
  });
  return Promise.resolve();
};
