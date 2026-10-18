import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { environment, project } from "./project.js";

export const webhookEvent = pgTable(
  "webhook_event",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    body: text("body").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.projectId, table.environmentId, table.sourceKey),
    unique().on(table.id, table.projectId, table.environmentId),
    index("webhook_event_retention_idx").on(table.recordedAt),
    check(
      "webhook_event_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object' and octet_length(${table.payload}::text) <= 1048576 and octet_length(${table.body}) <= 1048576`,
    ),
    check(
      "webhook_event_type_check",
      sql`${table.eventType} in ('room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted', 'schedule.created','schedule.updated','schedule.starting','schedule.started','schedule.missed','schedule.cancelled','schedule.failed','schedule.completed','schedule.reminder','restream.probing','restream.source_connected','restream.source_lost','restream.recovering','restream.stopped','restream.failed','clip.requested','clip.rendering','clip.ready','clip.failed','clip.deleted','mixer.started','mixer.scene_activated','mixer.source_lost','mixer.overloaded','mixer.stopped','mixer.failed','dvr.enabled','dvr.window_changed','dvr.segment_evicted','dvr.disabled','stream.guest.invited','stream.guest.invite_accepted','stream.guest.invite_declined','stream.guest.requested','stream.guest.request_approved','stream.guest.request_rejected','stream.guest.joined','stream.guest.left','stream.guest.removed','stream.guest.muted','stream.guest.invite_expired','stream.guest.invite_cancelled','stream.guest.grant_revoked')`,
    ),
  ],
);

export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: text("id")
      .primaryKey()
      .default(sql`'delivery_' || gen_random_uuid()::text`),
    eventId: text("event_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    url: text("url").notNull(),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    runAttemptCount: integer("run_attempt_count").default(0).notNull(),
    replayCount: integer("replay_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    leaseToken: text("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.eventId, table.endpointId),
    foreignKey({
      columns: [table.eventId, table.projectId, table.environmentId],
      foreignColumns: [webhookEvent.id, webhookEvent.projectId, webhookEvent.environmentId],
    }).onDelete("cascade"),
    index("webhook_delivery_due_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index("webhook_delivery_lease_idx")
      .on(table.leasedUntil)
      .where(sql`${table.status} = 'delivering'`),
    index("webhook_delivery_scope_idx").on(
      table.projectId,
      table.environmentId,
      table.endpointId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("webhook_delivery_retention_idx")
      .on(table.updatedAt)
      .where(sql`${table.status} in ('succeeded', 'failed', 'cancelled')`),
    check(
      "webhook_delivery_status_check",
      sql`${table.status} in ('pending', 'delivering', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "webhook_delivery_attempt_count_check",
      sql`${table.attemptCount} >= 0 and ${table.runAttemptCount} between 0 and 8`,
    ),
    check("webhook_delivery_replay_count_check", sql`${table.replayCount} between 0 and 100`),
    check(
      "webhook_delivery_lease_check",
      sql`(${table.status} = 'delivering' and ${table.leaseToken} is not null and ${table.leasedUntil} is not null) or (${table.status} <> 'delivering' and ${table.leaseToken} is null and ${table.leasedUntil} is null)`,
    ),
  ],
);

export const webhookDeliveryAttempt = pgTable(
  "webhook_delivery_attempt",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => webhookDelivery.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    replayCount: integer("replay_count").notNull(),
    status: text("status").default("started").notNull(),
    signingSecretVersion: integer("signing_secret_version").notNull(),
    signatureTimestamp: bigint("signature_timestamp", { mode: "number" }).notNull(),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.deliveryId, table.attemptNumber),
    check("webhook_attempt_number_check", sql`${table.attemptNumber} > 0`),
    check(
      "webhook_attempt_status_check",
      sql`${table.status} in ('started', 'succeeded', 'failed', 'abandoned')`,
    ),
    check("webhook_attempt_replay_check", sql`${table.replayCount} between 0 and 100`),
    check("webhook_attempt_secret_check", sql`${table.signingSecretVersion} > 0`),
    check("webhook_attempt_signature_timestamp_check", sql`${table.signatureTimestamp} > 0`),
    check("webhook_attempt_http_status_check", sql`${table.httpStatus} between 100 and 599`),
  ],
);

export const webhookEndpoint = pgTable(
  "webhook_endpoint",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").notNull(),
    url: text("url").notNull(),
    eventTypes: text("event_types").array().notNull(),
    status: text("status").default("enabled").notNull(),
    encryptedSigningSecret: text("encrypted_signing_secret").notNull(),
    signingSecretVersion: integer("signing_secret_version").default(1).notNull(),
    signingSecretRotatedAt: timestamp("signing_secret_rotated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environment.id, environment.projectId],
      name: "webhook_endpoint_environment_project_fk",
    }).onDelete("cascade"),
    index("webhook_endpoint_scope_idx")
      .on(table.projectId, table.environmentId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    check("webhook_endpoint_url_check", sql`length(${table.url}) <= 2048`),
    check("webhook_endpoint_status_check", sql`${table.status} in ('enabled', 'disabled')`),
    check("webhook_endpoint_secret_version_check", sql`${table.signingSecretVersion} > 0`),
    check(
      "webhook_endpoint_events_check",
      sql`cardinality(${table.eventTypes}) between 1 and 77 and ${table.eventTypes} <@ ARRAY['room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted', 'schedule.created','schedule.updated','schedule.starting','schedule.started','schedule.missed','schedule.cancelled','schedule.failed','schedule.completed','schedule.reminder','restream.probing','restream.source_connected','restream.source_lost','restream.recovering','restream.stopped','restream.failed','clip.requested','clip.rendering','clip.ready','clip.failed','clip.deleted','mixer.started','mixer.scene_activated','mixer.source_lost','mixer.overloaded','mixer.stopped','mixer.failed','dvr.enabled','dvr.window_changed','dvr.segment_evicted','dvr.disabled','stream.guest.invited','stream.guest.invite_accepted','stream.guest.invite_declined','stream.guest.requested','stream.guest.request_approved','stream.guest.request_rejected','stream.guest.joined','stream.guest.left','stream.guest.removed','stream.guest.muted','stream.guest.invite_expired','stream.guest.invite_cancelled','stream.guest.grant_revoked']::text[] and array_position(${table.eventTypes}, NULL) is null`,
    ),
    check(
      "webhook_endpoint_deleted_check",
      sql`${table.deletedAt} is null or ${table.status} = 'disabled'`,
    ),
  ],
);
