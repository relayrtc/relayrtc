import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  jsonb,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { broadcastRun } from "./broadcast.js";
import { streamingStream, streamingSession } from "./streaming.js";
const time = (name: string) => timestamp(name, { withTimezone: true });
export const mixer = pgTable(
  "mixer",
  {
    id: text("id").primaryKey(),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => broadcastRun.id),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    state: text("state").notNull().default("created"),
    desiredState: text("desired_state").notNull().default("running"),
    version: integer("version").notNull().default(1),
    desiredVersion: integer("desired_version").notNull().default(0),
    appliedVersion: integer("applied_version").notNull().default(0),
    desiredSceneId: text("desired_scene_id"),
    appliedSceneId: text("applied_scene_id"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    appliedSnapshot: jsonb("applied_snapshot").$type<Record<string, unknown>>(),
    lostSources: jsonb("lost_sources").$type<string[]>().notNull().default([]),
    lastError: text("last_error"),
    eventSequence: integer("event_sequence").notNull().default(0),
    renderSeconds: doublePrecision("render_seconds").notNull().default(0),
    programSeconds: doublePrecision("program_seconds").notNull().default(0),
    inputSeconds: doublePrecision("input_seconds").notNull().default(0),
    frames: bigint("frames", { mode: "number" }).notNull().default(0),
    createdAt: time("created_at").notNull().defaultNow(),
    activatedAt: time("activated_at"),
    stopRequestedAt: time("stop_requested_at"),
    endedAt: time("ended_at"),
  },
  (t) => [
    uniqueIndex("mixer_active_stream_idx")
      .on(t.streamId)
      .where(sql`${t.state} NOT IN ('stopped','failed')`),
    index("mixer_scope_idx").on(t.projectId, t.environmentId, t.id),
  ],
);
export const mixerSource = pgTable(
  "mixer_source",
  {
    mixerId: text("mixer_id")
      .notNull()
      .references(() => mixer.id),
    id: text("id").notNull(),
    streamId: text("stream_id")
      .notNull()
      .references(() => streamingStream.id),
  },
  (t) => [primaryKey({ columns: [t.mixerId, t.id] })],
);
export const mixerScene = pgTable(
  "mixer_scene",
  {
    mixerId: text("mixer_id")
      .notNull()
      .references(() => mixer.id),
    id: text("id").notNull(),
    version: integer("version").notNull().default(1),
    scene: jsonb("scene").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.mixerId, t.id] })],
);
export const mixerOverlay = pgTable(
  "mixer_overlay",
  {
    id: text("id").primaryKey(),
    mixerId: text("mixer_id")
      .notNull()
      .references(() => mixer.id),
    name: text("name").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull().unique(),
    state: text("state").notNull().default("pending"),
    createdAt: time("created_at").notNull().defaultNow(),
    deletionRequestedAt: time("deletion_requested_at"),
  },
  (t) => [
    index("mixer_overlay_owner_idx").on(t.mixerId, t.state),
    index("mixer_overlay_live_idx")
      .on(t.state, t.createdAt)
      .where(sql`${t.state} IN ('pending','ready','deleting')`),
  ],
);
export const mixerRenderSession = pgTable(
  "mixer_render_session",
  {
    mixerId: text("mixer_id")
      .notNull()
      .references(() => mixer.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => streamingSession.id),
    generation: integer("generation").notNull(),
    sequence: integer("sequence").notNull().default(0),
    candidateRevision: integer("candidate_revision").notNull().default(0),
    candidateSequence: integer("candidate_sequence").notNull().default(0),
    frames: bigint("frames", { mode: "number" }).notNull().default(0),
    startedAt: time("started_at").notNull().defaultNow(),
    endedAt: time("ended_at"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.generation] })],
);
export const mixerUsage = pgTable(
  "mixer_usage",
  {
    mixerId: text("mixer_id")
      .notNull()
      .references(() => mixer.id),
    sessionId: text("session_id").notNull(),
    generation: integer("generation").notNull(),
    sequence: integer("sequence").notNull(),
    renderSeconds: doublePrecision("render_seconds").notNull(),
    programSeconds: doublePrecision("program_seconds").notNull(),
    inputSeconds: doublePrecision("input_seconds").notNull(),
    frames: integer("frames").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.generation, t.sequence] }),
    index("mixer_usage_retention_idx").on(t.createdAt),
  ],
);
export const mixerOperation = pgTable(
  "mixer_operation",
  {
    id: text("id").primaryKey(),
    mixerId: text("mixer_id")
      .notNull()
      .references(() => mixer.id),
    kind: text("kind").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    createdAt: time("created_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
  },
  (t) => [
    index("mixer_operation_owner_idx").on(t.mixerId, t.status),
    index("mixer_operation_retention_idx")
      .on(t.completedAt)
      .where(sql`${t.status}<>'pending'`),
  ],
);
