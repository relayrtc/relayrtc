import "server-only";

import { schema } from "@relayrtc/database";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getAuthRuntime } from "@/lib/auth-server";
import { requireProject } from "@/lib/console-data";

export const activityViews = ["rooms", "streams", "assets", "sources"] as const;
export type ActivityView = (typeof activityViews)[number];
export type ActivityRow = {
  id: string;
  label: string;
  detail: string;
  status: string;
  createdAt: Date;
};

export async function activityContext(orgId: string, projectId: string, environmentId?: string) {
  const project = await requireProject(orgId, projectId);
  const environments = project.environments.filter((item) => item.status === "active");
  const environment = environmentId
    ? environments.find((item) => item.id === environmentId)
    : (environments.find((item) => item.type === "development") ?? environments[0]);
  if (environmentId && !environment) notFound();
  return { orgId, projectId, environments, environment };
}

type Context = Awaited<ReturnType<typeof activityContext>>;

export async function listActivity(
  context: Context,
  view: ActivityView,
  page: number,
  search: string,
  assetKind: "all" | "recording" | "clip" | "buffer" = "all",
) {
  if (!context.environment) return { rows: [], hasNext: false };
  const database = getAuthRuntime().database;
  const scope = { projectId: context.projectId, environmentId: context.environment.id };
  const pattern = `%${search}%`;
  const offset = page * 30;
  let rows: ActivityRow[];
  if (view === "rooms") {
    const t = schema.room;
    rows = await database
      .select({
        id: t.id,
        label: t.name,
        status: t.status,
        createdAt: t.createdAt,
        detail: sql<string>`${t.maxParticipants}::text || ' participant capacity'`,
      })
      .from(t)
      .where(
        and(
          eq(t.projectId, scope.projectId),
          eq(t.environmentId, scope.environmentId),
          or(ilike(t.name, pattern), ilike(t.id, pattern)),
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(31)
      .offset(offset);
  } else if (view === "streams") {
    const t = schema.streamingStream;
    rows = await database
      .select({
        id: t.id,
        label: t.name,
        createdAt: t.createdAt,
        detail: sql<string>`coalesce(${t.source}->>'kind', 'unknown')`,
        status: sql<string>`case when ${t.status} <> 'active' then ${t.status} else coalesce((select state from streaming_session where stream_id = ${t.id} order by created_at desc, id desc limit 1), 'not_started') end`,
      })
      .from(t)
      .where(
        and(
          eq(t.organizationId, context.orgId),
          eq(t.projectId, scope.projectId),
          eq(t.environmentId, scope.environmentId),
          or(ilike(t.name, pattern), ilike(t.id, pattern)),
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(31)
      .offset(offset);
  } else if (view === "assets") {
    const t = schema.recording;
    rows = await database
      .select({ id: t.id, label: t.id, status: t.state, createdAt: t.createdAt, detail: t.kind })
      .from(t)
      .innerJoin(schema.streamingStream, eq(t.streamId, schema.streamingStream.id))
      .where(
        and(
          eq(schema.streamingStream.organizationId, context.orgId),
          eq(t.projectId, scope.projectId),
          eq(t.environmentId, scope.environmentId),
          eq(schema.streamingStream.projectId, scope.projectId),
          eq(schema.streamingStream.environmentId, scope.environmentId),
          or(ilike(t.id, pattern), ilike(t.kind, pattern)),
          assetKind === "all" ? undefined : eq(t.kind, assetKind),
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(31)
      .offset(offset);
  } else {
    const t = schema.restreamSource;
    rows = await database
      .select({
        id: t.id,
        label: t.name,
        status: t.state,
        createdAt: t.createdAt,
        detail: t.protocol,
      })
      .from(t)
      .innerJoin(schema.streamingStream, eq(t.streamId, schema.streamingStream.id))
      .where(
        and(
          eq(schema.streamingStream.organizationId, context.orgId),
          eq(t.projectId, scope.projectId),
          eq(t.environmentId, scope.environmentId),
          eq(schema.streamingStream.projectId, scope.projectId),
          eq(schema.streamingStream.environmentId, scope.environmentId),
          or(ilike(t.id, pattern), ilike(t.name, pattern)),
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(31)
      .offset(offset);
  }
  return { rows: rows.slice(0, 30), hasNext: rows.length > 30 };
}

export async function inspectActivity(
  context: Context,
  view: ActivityView,
  resourceId: string,
  page: number,
) {
  if (!context.environment) notFound();
  const database = getAuthRuntime().database;
  const scope = { projectId: context.projectId, environmentId: context.environment.id };
  if (view === "rooms") {
    const t = schema.room;
    const [room] = await database
      .select({
        id: t.id,
        name: t.name,
        status: t.status,
        maxParticipants: t.maxParticipants,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      })
      .from(t)
      .where(
        and(
          eq(t.id, resourceId),
          eq(t.projectId, scope.projectId),
          eq(t.environmentId, scope.environmentId),
        ),
      );
    if (!room) notFound();
    const s = schema.participantSession,
      p = schema.participant;
    const sessions = await database
      .select({
        id: s.id,
        participantId: p.id,
        name: p.name,
        role: p.role,
        state: s.connectionState,
        transport: s.transportType,
        joinedAt: s.joinedAt,
        disconnectedAt: s.disconnectedAt,
        messagesIn: s.messagesIn,
        messagesOut: s.messagesOut,
      })
      .from(s)
      .innerJoin(p, eq(s.participantId, p.id))
      .where(eq(p.roomId, room.id))
      .orderBy(desc(s.joinedAt), desc(s.id))
      .limit(31)
      .offset(page * 30);
    return {
      kind: "rooms" as const,
      room,
      sessions: sessions.slice(0, 30),
      hasNext: sessions.length > 30,
    };
  }
  if (view === "streams") {
    const t = schema.streamingStream;
    const [stream] = await database
      .select({
        id: t.id,
        name: t.name,
        status: t.status,
        createdAt: t.createdAt,
        sourceKind: sql<string>`coalesce(${t.source}->>'kind', 'unknown')`,
      })
      .from(t)
      .where(
        and(
          eq(t.id, resourceId),
          eq(t.organizationId, context.orgId),
          eq(t.projectId, scope.projectId),
          eq(t.environmentId, scope.environmentId),
        ),
      );
    if (!stream) notFound();
    const s = schema.streamingSession,
      b = schema.broadcastRun;
    const j = schema.broadcastJob;
    const [sessions, broadcasts, outputs] = await Promise.all([
      database
        .select({
          id: s.id,
          state: s.state,
          createdAt: s.createdAt,
          attempts: s.attempts,
          lastError: s.lastError,
          ingressBitrate: s.ingressBitrate,
          programBitrate: s.programBitrate,
          lastHeartbeatAt: s.lastHeartbeatAt,
        })
        .from(s)
        .where(eq(s.streamId, stream.id))
        .orderBy(desc(s.createdAt), desc(s.id))
        .limit(31)
        .offset(page * 30),
      database
        .select({
          id: b.id,
          name: b.name,
          state: b.state,
          lastError: b.lastError,
          createdAt: b.createdAt,
          endedAt: b.endedAt,
        })
        .from(b)
        .where(
          and(
            eq(b.streamId, stream.id),
            eq(b.projectId, scope.projectId),
            eq(b.environmentId, scope.environmentId),
          ),
        )
        .orderBy(desc(b.createdAt), desc(b.id))
        .limit(31)
        .offset(page * 30),
      database
        .select({
          id: j.id,
          broadcastId: j.broadcastId,
          destinationId: schema.broadcastOutput.destinationId,
          state: j.state,
          kind: j.kind,
          attempts: j.attempts,
          lastError: j.lastError,
          lastHeartbeatAt: j.lastHeartbeatAt,
          outputSeconds: j.outputSeconds,
          egressBytes: j.egressBytes,
        })
        .from(j)
        .innerJoin(b, eq(j.broadcastId, b.id))
        .leftJoin(schema.broadcastOutput, and(eq(j.outputId, schema.broadcastOutput.id), eq(j.broadcastId, schema.broadcastOutput.broadcastId)))
        .where(
          and(
            eq(b.streamId, stream.id),
            eq(b.projectId, scope.projectId),
            eq(b.environmentId, scope.environmentId),
          ),
        )
        .orderBy(desc(b.createdAt), desc(j.id))
        .limit(31)
        .offset(page * 30),
    ]);
    return {
      kind: "streams" as const,
      stream,
      sessions: sessions.slice(0, 30),
      broadcasts: broadcasts.slice(0, 30),
      outputs: outputs.slice(0, 30),
      hasNext: sessions.length > 30 || broadcasts.length > 30 || outputs.length > 30,
    };
  }
  if (view === "assets") {
    const t = schema.recording;
    const [asset] = await database
      .select({
        id: t.id,
        kind: t.kind,
        assetId: t.assetId,
        state: t.state,
        streamId: t.streamId,
        broadcastId: t.broadcastId,
        durationSeconds: t.durationSeconds,
        storedBytes: t.storedBytes,
        partial: t.partial,
        lastError: t.lastError,
        createdAt: t.createdAt,
        endedAt: t.endedAt,
        expiresAt: t.expiresAt,
      })
      .from(t)
      .innerJoin(schema.streamingStream, eq(t.streamId, schema.streamingStream.id))
      .where(
        and(
          eq(t.id, resourceId),
          eq(t.projectId, scope.projectId),
          eq(t.environmentId, scope.environmentId),
          eq(schema.streamingStream.organizationId, context.orgId),
          eq(schema.streamingStream.projectId, scope.projectId),
          eq(schema.streamingStream.environmentId, scope.environmentId),
        ),
      );
    if (!asset) notFound();
    return { kind: "assets" as const, asset, hasNext: false };
  }
  const t = schema.restreamSource;
  const [source] = await database
    .select({
      id: t.id,
      name: t.name,
      protocol: t.protocol,
      state: t.state,
      streamId: t.streamId,
      lastError: t.lastError,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
    .from(t)
    .innerJoin(schema.streamingStream, eq(t.streamId, schema.streamingStream.id))
    .where(
      and(
        eq(t.id, resourceId),
        eq(t.projectId, scope.projectId),
        eq(t.environmentId, scope.environmentId),
        eq(schema.streamingStream.organizationId, context.orgId),
        eq(schema.streamingStream.projectId, scope.projectId),
        eq(schema.streamingStream.environmentId, scope.environmentId),
      ),
    );
  if (!source) notFound();
  return { kind: "sources" as const, source, hasNext: false };
}
