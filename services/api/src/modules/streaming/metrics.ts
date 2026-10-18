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
    const [recordings] = await database.execute(
      sql`SELECT count(*) FILTER(WHERE state='recording')::int AS active,count(*) FILTER(WHERE state='finalizing')::int AS finalizing,count(*) FILTER(WHERE state='failed')::int AS failed,coalesce(sum(duration_seconds),0)::float8 AS seconds,coalesce(sum(processing_seconds),0)::float8 AS processing,coalesce(sum(stored_bytes),0)::float8 AS bytes,coalesce(sum(storage_byte_seconds),0)::float8 AS byte_seconds FROM recording`,
    );
    for (const metric of [
      "active",
      "finalizing",
      "failed",
      "seconds",
      "processing",
      "bytes",
      "byte_seconds",
    ])
      lines.push(`relayrtc_recording_${metric} ${String(Number(recordings?.[metric] ?? 0))}`);
    const [clips] = await database.execute(
      sql`SELECT count(*) FILTER(WHERE r.state='queued')::int AS queued,count(*) FILTER(WHERE r.state='finalizing')::int AS rendering,count(*) FILTER(WHERE r.state='failed')::int AS failed,coalesce(sum(r.processing_seconds),0)::float8 AS processing_seconds,coalesce(sum(r.stored_bytes),0)::float8 AS stored_bytes,coalesce(sum(r.storage_byte_seconds),0)::float8 AS storage_byte_seconds FROM clip_request c JOIN recording r ON r.id=c.recording_id`,
    );
    for (const metric of [
      "queued",
      "rendering",
      "failed",
      "processing_seconds",
      "stored_bytes",
      "storage_byte_seconds",
    ])
      lines.push(`relayrtc_clip_${metric} ${String(Number(clips?.[metric] ?? 0))}`);
    const [pins] = await database.execute(sql`SELECT count(*)::int AS n FROM clip_segment_pin`);
    lines.push(`relayrtc_clip_pinned_segments ${String(Number(pins?.n ?? 0))}`);
    const guests = await database.execute(
      sql`SELECT state,count(*)::int AS n FROM stream_guest GROUP BY state`,
    );
    for (const g of guests)
      lines.push(`relayrtc_stream_guests{state="${String(g.state)}"} ${String(g.n)}`);
    const [guestStage] = await database.execute(
      sql`SELECT count(*) FILTER(WHERE enabled)::int AS enabled FROM stream_guest_stage`,
    );
    const [guestCleanup] = await database.execute(
      sql`SELECT count(*)::int AS n FROM participant_removal_target t WHERE left(t.participant_id,7)='guestp_' AND t.status<>'completed' AND t.available_at<now()-interval '30 seconds'`,
    );
    lines.push(
      `relayrtc_guest_stages ${String(Number(guestStage?.enabled ?? 0))}`,
      `relayrtc_guest_cleanup_stalled ${String(Number(guestCleanup?.n ?? 0))}`,
    );
    const [dvr] = await database.execute(
      sql`SELECT count(*) FILTER(WHERE w.state='active')::int AS active,count(*) FILTER(WHERE w.state='draining')::int AS draining,coalesce(sum(w.delivered_bytes),0)::float8 AS delivered_bytes,count(*) FILTER(WHERE w.state='active' AND r.state='recording' AND (r.last_error='BUFFER_STORAGE_PRESSURE' OR r.heartbeat_at<now()-interval '30 seconds'))::int AS stalled FROM dvr_window w JOIN recording r ON r.id=w.recording_id`,
    );
    for (const metric of ["active", "draining", "delivered_bytes", "stalled"])
      lines.push(`relayrtc_dvr_${metric} ${String(Number(dvr?.[metric] ?? 0))}`);
    const [dvrPins] = await database.execute(sql`SELECT count(*)::int AS n FROM dvr_segment_pin`);
    lines.push(`relayrtc_dvr_manifest_pins ${String(Number(dvrPins?.n ?? 0))}`);
    const [buffers] = await database.execute(
      sql`SELECT count(*) FILTER(WHERE state='recording')::int AS active,coalesce(sum(stored_bytes),0)::float8 AS bytes FROM recording WHERE kind='buffer'`,
    );
    lines.push(
      `relayrtc_buffer_active ${String(Number(buffers?.active ?? 0))}`,
      `relayrtc_buffer_stored_bytes ${String(Number(buffers?.bytes ?? 0))}`,
    );
    const mixers = await database.execute(
      sql`SELECT state,count(*)::int AS n FROM mixer GROUP BY state`,
    );
    for (const m of mixers)
      lines.push(`relayrtc_mixers{state="${String(m.state)}"} ${String(Number(m.n))}`);
    const [mixUsage] = await database.execute(
      sql`SELECT coalesce(sum(render_seconds),0)::float8 AS render_seconds,coalesce(sum(program_seconds),0)::float8 AS program_seconds,coalesce(sum(input_seconds),0)::float8 AS input_seconds,coalesce(sum(frames),0)::float8 AS frames FROM mixer`,
    );
    for (const metric of ["render_seconds", "program_seconds", "input_seconds", "frames"])
      lines.push(`relayrtc_mixer_${metric} ${String(Number(mixUsage?.[metric] ?? 0))}`);
    const [mixLag] = await database.execute(
      sql`SELECT count(*) FILTER(WHERE desired_version<>applied_version AND desired_state='running')::int AS pending,coalesce(max(EXTRACT(EPOCH FROM now()-activated_at)) FILTER(WHERE desired_version<>applied_version AND desired_state='running'),0)::float8 AS lag FROM mixer`,
    );
    lines.push(
      `relayrtc_mixer_pending_activations ${String(Number(mixLag?.pending ?? 0))}`,
      `relayrtc_mixer_activation_lag_seconds ${String(Number(mixLag?.lag ?? 0))}`,
    );
    const [overlayBytes] = await database.execute(
      sql`SELECT coalesce(sum(size_bytes),0)::float8 AS n FROM mixer_overlay WHERE state<>'deleted'`,
    );
    lines.push(`relayrtc_mixer_overlay_reserved_bytes ${String(Number(overlayBytes?.n ?? 0))}`);
    const schedules = await database.execute(
      sql`SELECT state,count(*)::int AS n FROM broadcast_schedule GROUP BY state`,
    );
    for (const row of schedules)
      lines.push(`relayrtc_schedules{state="${String(row.state)}"} ${String(row.n)}`);
    const [lag] = await database.execute(
      sql`SELECT coalesce(max(EXTRACT(EPOCH FROM now()-starts_at)),0)::float8 AS seconds,count(*) FILTER(WHERE leased_until<now())::int AS expired FROM broadcast_schedule WHERE state='scheduled' AND starts_at<=now()`,
    );
    lines.push(
      `relayrtc_schedule_due_lag_seconds ${String(Number(lag?.seconds ?? 0))}`,
      `relayrtc_schedule_expired_leases ${String(Number(lag?.expired ?? 0))}`,
    );
    const broadcastStates = await database.execute(
      sql`SELECT state,count(*)::int AS value FROM broadcast_run GROUP BY state`,
    );
    for (const item of broadcastStates) {
      // State values are constrained by the database, never user-provided labels.
      lines.push(`relayrtc_broadcast_runs{state="${String(item.state)}"} ${String(item.value)}`);
    }
    const [jobs] =
      await database.execute(sql`SELECT count(*) FILTER (WHERE state='running')::int AS running,
      count(*) FILTER (WHERE state='failed')::int AS failed,
      count(*) FILTER (WHERE leased_until<now())::int AS expired,
      coalesce(max(extract(epoch from now()-available_at)) FILTER (WHERE state IN ('queued','retry') AND available_at<=now() AND EXISTS (
        SELECT 1 FROM broadcast_run b JOIN streaming_session s ON s.id=b.source_session_id WHERE b.id=broadcast_job.broadcast_id
        AND b.desired_state='running' AND s.state='live' AND s.desired_state='running' AND s.generation=b.source_generation AND s.leased_until>now()
      )),0)::float8 AS delay FROM broadcast_job`);
    const [reserved] = await database.execute(
      sql`SELECT count(*)::int AS value FROM broadcast_reservation`,
    );
    const [usage] = await database.execute(
      sql`SELECT coalesce(sum(egress_bytes),0)::float8 AS bytes,coalesce(sum(transcode_seconds),0)::float8 AS transcode,coalesce(sum(run_seconds),0)::float8 AS run,coalesce(sum(output_seconds),0)::float8 AS live,coalesce(sum(reservation_seconds),0)::float8 AS reserved FROM broadcast_run`,
    );
    lines.push(
      `relayrtc_broadcast_running_outputs ${String(Number(jobs?.running ?? 0))}`,
      `relayrtc_broadcast_failed_outputs ${String(Number(jobs?.failed ?? 0))}`,
      `relayrtc_broadcast_expired_leases ${String(Number(jobs?.expired ?? 0))}`,
      `relayrtc_broadcast_queue_delay_seconds ${String(Number(jobs?.delay ?? 0))}`,
      `relayrtc_broadcast_reserved_slots ${String(Number(reserved?.value ?? 0))}`,
      `relayrtc_broadcast_egress_bytes ${String(Number(usage?.bytes ?? 0))}`,
      `relayrtc_broadcast_transcode_seconds ${String(Number(usage?.transcode ?? 0))}`,
      `relayrtc_broadcast_run_seconds ${String(Number(usage?.run ?? 0))}`,
      `relayrtc_broadcast_output_seconds ${String(Number(usage?.live ?? 0))}`,
      `relayrtc_broadcast_reservation_seconds ${String(Number(usage?.reserved ?? 0))}`,
      `relayrtc_broadcast_admission_enabled ${config.broadcastsEnabled ? "1" : "0"}`,
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
    const [sources] = await database.execute(
      sql`SELECT count(*) FILTER(WHERE ended_at IS NULL)::int active,count(*) FILTER(WHERE ended_at IS NULL AND leased_until<now())::int expired FROM restream_session`,
    );
    const [sourceUsage] = await database.execute(
      sql`SELECT coalesce(sum(fetched_bytes),0)::float8 bytes,coalesce(sum(processing_seconds),0)::float8 seconds FROM restream_session`,
    );
    lines.push(
      `relayrtc_restream_active_sessions ${String(Number(sources?.active ?? 0))}`,
      `relayrtc_restream_expired_leases ${String(Number(sources?.expired ?? 0))}`,
      `relayrtc_restream_observed_fetch_bytes ${String(Number(sourceUsage?.bytes ?? 0))}`,
      `relayrtc_restream_observed_processing_seconds ${String(Number(sourceUsage?.seconds ?? 0))}`,
    );
    return reply
      .header("cache-control", "no-store")
      .type("text/plain; version=0.0.4")
      .send(lines.join("\n") + "\n");
  });
  return Promise.resolve();
};
