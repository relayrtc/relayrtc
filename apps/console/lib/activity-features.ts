import "server-only";
import { schema } from "@relayrtc/database";
import { and, desc, eq, sql } from "drizzle-orm";
import { getAuthRuntime } from "@/lib/auth-server";
import type { activityContext } from "@/lib/activity";
export type InspectionValue = string | number | boolean | Date | null;
export type InspectionGroup = {
    title: string;
    rows: Record<string, InspectionValue>[];
    hasNext: boolean;
};
export async function inspectStreamFeatures(context: Awaited<ReturnType<typeof activityContext>>, streamId: string, page: number): Promise<InspectionGroup[]> {
    if (!context.environment)
        return [];
    const database = getAuthRuntime().database;
    const { streamingStream: s, mixer: m, mixerSource: mi, mixerScene: ms, broadcastSchedule: sc, scheduleAttempt: sa, streamGuestStage: gs, streamGuest: g, streamAudience: a, streamDestination: d, dvrWindow: dw, recording: r } = schema;
    const scope = and(eq(s.organizationId, context.orgId), eq(s.projectId, context.projectId), eq(s.environmentId, context.environment.id), eq(s.id, streamId));
    const results = await Promise.all([
        database.select({ "Mixer ID": m.id, "Broadcast ID": m.broadcastId, "State": m.state, "Desired state": m.desiredState, "Desired scene": m.desiredSceneId, "Applied scene": m.appliedSceneId, "Desired revision": m.desiredVersion, "Applied revision": m.appliedVersion, "Lost input IDs": sql<string> `array_to_string(ARRAY(SELECT jsonb_array_elements_text(${m.lostSources})), ', ')`, "Created": m.createdAt, "Activated": m.activatedAt, "Ended": m.endedAt, "Error": m.lastError }).from(m).innerJoin(s, eq(m.streamId, s.id)).where(and(eq(m.streamId, streamId), scope)).orderBy(desc(m.createdAt), desc(m.id)).limit(31).offset(page * 30),
        database.select({ "Mixer ID": mi.mixerId, "Input ID": mi.id, "Source stream ID": mi.streamId }).from(mi).innerJoin(m, eq(mi.mixerId, m.id)).innerJoin(s, eq(m.streamId, s.id)).where(and(eq(m.streamId, streamId), scope)).orderBy(desc(mi.mixerId), desc(mi.id)).limit(31).offset(page * 30),
        database.select({ "Mixer ID": ms.mixerId, "Scene ID": ms.id, "Version": ms.version }).from(ms).innerJoin(m, eq(ms.mixerId, m.id)).innerJoin(s, eq(m.streamId, s.id)).where(and(eq(m.streamId, streamId), scope)).orderBy(desc(ms.mixerId), desc(ms.id)).limit(31).offset(page * 30),
        database.select({ "Schedule ID": sc.id, "Name": sc.name, "Broadcast ID": sc.broadcastId, "State": sc.state, "Scheduled start": sc.startsAt, "Scheduled end": sc.endsAt, "Original time zone": sc.timeZone, "Actual start": sc.startedAt, "Actual end": sc.endedAt, "Attempts": sc.attempts, "Next attempt": sc.nextAttemptAt, "Source deadline": sc.sourceDeadline, "Error": sc.lastError }).from(sc).innerJoin(s, eq(sc.streamId, s.id)).where(and(eq(sc.streamId, streamId), scope)).orderBy(desc(sc.createdAt), desc(sc.id)).limit(31).offset(page * 30),
        database.select({ "Schedule ID": sa.scheduleId, "Attempt": sa.fence, "State": sa.state, "Started": sa.createdAt, "Ended": sa.endedAt, "Error": sa.reason }).from(sa).innerJoin(sc, eq(sa.scheduleId, sc.id)).innerJoin(s, eq(sc.streamId, s.id)).where(and(eq(sc.streamId, streamId), scope)).orderBy(desc(sa.createdAt), desc(sa.scheduleId), desc(sa.fence)).limit(31).offset(page * 30),
        database.select({ "Broadcast ID": gs.broadcastId, "Room ID": gs.roomId, "Enabled": gs.enabled, "Guest capacity": gs.maxGuests, "Layout": gs.layout, "Version": gs.version }).from(gs).innerJoin(s, eq(gs.streamId, s.id)).where(and(eq(gs.streamId, streamId), scope)).orderBy(desc(gs.broadcastId)).limit(31).offset(page * 30),
        database.select({ "Guest ID": g.id, "Broadcast ID": g.broadcastId, "Name": g.name, "Entry type": g.kind, "State": g.state, "Participant ID": g.participantId, "Audio muted": g.mutedAudio, "Video muted": g.mutedVideo, "Created": g.createdAt, "Last joined": g.lastJoinedAt, "Expires": g.expiresAt }).from(g).innerJoin(gs, eq(g.broadcastId, gs.broadcastId)).innerJoin(s, eq(gs.streamId, s.id)).where(and(eq(gs.streamId, streamId), scope)).orderBy(desc(g.createdAt), desc(g.id)).limit(31).offset(page * 30),
        database.select({ "Audience ID": a.id, "Broadcast ID": a.broadcastId, "Name": a.name, "Role": a.role, "Expires": a.expiresAt }).from(a).innerJoin(gs, eq(a.broadcastId, gs.broadcastId)).innerJoin(s, eq(gs.streamId, s.id)).where(scope).orderBy(desc(a.id)).limit(31).offset(page * 30),
        database.select({ "Destination ID": d.id, "Name": d.name, "Protocol": d.protocol, "Host": d.host, "Port": d.port, "Profile": d.profile, "Enabled": d.enabled, "Deleted": d.deletedAt, "Updated": d.updatedAt }).from(d).innerJoin(s, eq(d.streamId, s.id)).where(and(eq(d.streamId, streamId), scope)).orderBy(desc(d.createdAt), desc(d.id)).limit(31).offset(page * 30),
        database.select({ "Window ID": dw.id, "Buffer recording ID": dw.recordingId, "State": dw.state, "Policy version": dw.policyVersion, "Window duration (seconds)": sql<string> `${dw.policy}->>'durationSeconds'`, "Maximum bytes": sql<string> `${dw.policy}->>'maxBytes'`, "Expires": dw.expiresAt, "Last event": dw.lastEventAt, "Last reported segment start": dw.lastStart, "Last reported segment end": dw.lastEnd, "End position": dw.endPosition }).from(dw).innerJoin(r, eq(dw.recordingId, r.id)).innerJoin(s, eq(r.streamId, s.id)).where(and(eq(r.streamId, streamId), scope)).orderBy(desc(r.createdAt), desc(dw.id)).limit(31).offset(page * 30)
    ]);
    const titles = ["Mixers", "Mixer inputs", "Mixer scenes", "Scheduled broadcasts", "Schedule execution history", "Guest stages", "Guests and cohosting", "Audience roles", "Multistream destinations", "DVR windows"];
    return results.map((rows, index) => ({ title: titles[index]!, rows: rows.slice(0, 30), hasNext: rows.length > 30 }));
}
export async function inspectAssetFeatures(context: Awaited<ReturnType<typeof activityContext>>, recordingId: string): Promise<InspectionGroup[]> {
    if (!context.environment)
        return [];
    const database = getAuthRuntime().database;
    const { streamingStream: s, recording: r, clipRequest: c, dvrWindow: d } = schema;
    const scope = and(eq(r.id, recordingId), eq(r.projectId, context.projectId), eq(r.environmentId, context.environment.id), eq(s.organizationId, context.orgId), eq(s.projectId, context.projectId), eq(s.environmentId, context.environment.id));
    const [clips, windows] = await Promise.all([
        database.select({ "Clip ID": c.id, "Label": c.label, "Source recording ID": c.sourceRecordingId, "Cut mode": c.cutMode, "Requested start (seconds)": c.requestedStartSeconds, "Requested end (seconds)": c.requestedEndSeconds, "Resolved start (seconds)": c.resolvedStartSeconds, "Resolved end (seconds)": c.resolvedEndSeconds, "Published": c.published, "Prepared": c.prepared }).from(c).innerJoin(r, eq(c.recordingId, r.id)).innerJoin(s, eq(r.streamId, s.id)).where(scope).limit(1),
        database.select({ "Window ID": d.id, "State": d.state, "Policy version": d.policyVersion, "Window duration (seconds)": sql<string> `${d.policy}->>'durationSeconds'`, "Maximum bytes": sql<string> `${d.policy}->>'maxBytes'`, "Expires": d.expiresAt, "Last event": d.lastEventAt, "Last reported segment start": d.lastStart, "Last reported segment end": d.lastEnd, "End position": d.endPosition }).from(d).innerJoin(r, eq(d.recordingId, r.id)).innerJoin(s, eq(r.streamId, s.id)).where(scope).limit(1)
    ]);
    return [{ title: "Clip details", rows: clips, hasNext: false }, { title: "DVR window", rows: windows, hasNext: false }].filter(group => group.rows.length);
}
