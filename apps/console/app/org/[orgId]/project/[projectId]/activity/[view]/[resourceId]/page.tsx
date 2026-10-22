import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/page/page-header";
import { ActivityRefresh } from "@/components/project/activity-refresh";
import {
  ActivitySection,
  ActivityFields,
  ActivityStatus,
  ActivityError,
  ActivityPagination,
  ResourceIdentity,
  activityDate,
} from "@/components/project/activity-view";
import { activityContext, activityViews, inspectActivity } from "@/lib/activity";
import { inspectStreamFeatures, inspectAssetFeatures } from "@/lib/activity-features";
import { ActivityFeatureSections } from "@/components/project/activity-feature-sections";
import { MediaPreview } from "@/components/project/media-preview";
import { formatBytes, formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Resource inspection" };

export default async function ActivityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string; view: string; resourceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, projectId, view, resourceId } = await params;
  const kind = z.enum(activityViews).safeParse(view);
  const query = z
    .object({
      environmentId: z.string().min(1).max(128).optional(),
      page: z.coerce.number().int().min(0).max(1000).default(0),
    })
    .safeParse(await searchParams);
  if (!kind.success || !query.success || resourceId.length > 128) notFound();
  const context = await activityContext(orgId, projectId, query.data.environmentId);
  const resource = await inspectActivity(context, kind.data, resourceId, query.data.page);
  const featureGroups = resource.kind === "streams" ? await inspectStreamFeatures(context, resourceId, query.data.page) : resource.kind === "assets" ? await inspectAssetFeatures(context, resourceId) : [];
  const base = `/org/${orgId}/project/${projectId}`;
  const environmentId = context.environment!.id;
  const link = (type: string, id: string) =>
    `${base}/activity/${type}/${encodeURIComponent(id)}?environmentId=${encodeURIComponent(environmentId)}`;
  const title =
    resource.kind === "rooms"
      ? resource.room.name
      : resource.kind === "streams"
        ? resource.stream.name
        : resource.kind === "sources"
          ? resource.source.name
          : `${resource.asset.kind === "buffer" ? "DVR / clip buffer" : resource.asset.kind} inspection`;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link
        className="text-sm text-muted-foreground hover:underline"
        href={`${base}/${view === "assets" ? "media" : "realtime"}?${new URLSearchParams({ view, environmentId })}`}
      >
        Back to {view === "assets" ? "media" : "realtime"}
      </Link>
      <PageHeader
        title={title}
        description={`${context.environment!.name} · Read-only inspection`}
        actions={<ActivityRefresh />}
      />
      <ResourceIdentity id={resourceId} />
      {resource.kind === "rooms" && (
        <>
          <ActivitySection title="Room">
            <ActivityFields
              fields={[
                ["Status", <ActivityStatus key="state" value={resource.room.status} />],
                ["Participant capacity", resource.room.maxParticipants],
                ["Created", activityDate(resource.room.createdAt)],
                ["Started", activityDate(resource.room.startedAt)],
                ["Ended", activityDate(resource.room.endedAt)],
              ]}
            />
          </ActivitySection>
          <ActivitySection title="Participant connection history">
            <div className="space-y-4">
              {resource.sessions.map((session) => (
                <div key={session.id} className="rounded-lg border p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="break-all text-sm font-medium">{session.name}</h3>
                    <ActivityStatus value={session.state} />
                  </div>
                  <ActivityFields
                    fields={[
                      ["Participant ID", session.participantId],
                      ["Session ID", session.id],
                      ["Role", session.role],
                      ["Signaling transport", session.transport.toUpperCase()],
                      ["Joined", activityDate(session.joinedAt)],
                      ["Disconnected", activityDate(session.disconnectedAt)],
                      ["Messages received", session.messagesIn],
                      ["Messages sent", session.messagesOut],
                    ]}
                  />
                </div>
              ))}
            </div>
            {!resource.sessions.length && (
              <p className="text-sm text-muted-foreground">No connection history on this page.</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Connection state is the last reported signaling state. Signaling transport does not
              identify the SFU or TURN media route.
            </p>
          </ActivitySection>
        </>
      )}
      {resource.kind === "streams" && (
        <>
          <ActivitySection title="Stream configuration">
            <ActivityFields
              fields={[
                ["Lifecycle", <ActivityStatus key="state" value={resource.stream.status} />],
                ["Source type", resource.stream.sourceKind.toUpperCase()],
                ["Created", activityDate(resource.stream.createdAt)],
              ]}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              An active configuration does not mean media is flowing. Inspect source sessions and
              broadcast status below.
            </p>
          </ActivitySection>
          <ActivitySection title="Source session history">
            <div className="space-y-4">
              {resource.sessions.map((session) => (
                <div key={session.id} className="rounded-lg border p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <ResourceIdentity id={session.id} />
                    <ActivityStatus value={session.state} />
                  </div>
                  <ActivityFields
                    fields={[
                      ["Created", activityDate(session.createdAt)],
                      ["Last heartbeat", activityDate(session.lastHeartbeatAt)],
                      ["Attempts", session.attempts],
                      [
                        "Last reported incoming bitrate",
                        `${(session.ingressBitrate / 1e6).toFixed(2)} Mbit/s`,
                      ],
                      [
                        "Last reported program bitrate",
                        `${(session.programBitrate / 1e6).toFixed(2)} Mbit/s`,
                      ],
                    ]}
                  />
                  <ActivityError value={session.lastError} />
                </div>
              ))}
            </div>
            {!resource.sessions.length && (
              <p className="text-sm text-muted-foreground">No source sessions on this page.</p>
            )}
          </ActivitySection>
          <ActivitySection title="Broadcast history">
            <div className="space-y-4">
              {resource.broadcasts.map((broadcast) => (
                <div key={broadcast.id} className="rounded-lg border p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="break-all text-sm font-medium">{broadcast.name}</h3>
                    <ActivityStatus value={broadcast.state} />
                  </div>
                  <ResourceIdentity id={broadcast.id} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Created {activityDate(broadcast.createdAt)} · Ended{" "}
                    {activityDate(broadcast.endedAt)}
                  </p>
                  <ActivityError value={broadcast.lastError} />
                </div>
              ))}
            </div>
            {!resource.broadcasts.length && (
              <p className="text-sm text-muted-foreground">No broadcasts on this page.</p>
            )}
          </ActivitySection>
          <ActivitySection title="Output health">
            <div className="space-y-4">
              {resource.outputs.map((output) => (
                <div key={output.id} className="rounded-lg border p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <ResourceIdentity id={output.id} />
                    <ActivityStatus value={output.state} />
                  </div>
                  <ActivityFields
                    fields={[
                      ["Broadcast ID", output.broadcastId],
                      ["Destination ID", output.destinationId],
                      ["Output type", output.kind.toUpperCase()],
                      ["Attempts", output.attempts],
                      ["Last heartbeat", activityDate(output.lastHeartbeatAt)],
                      ["Reported output time", formatDuration(output.outputSeconds)],
                      ["Reported external transfer", formatBytes(output.egressBytes)],
                    ]}
                  />
                  <ActivityError value={output.lastError} />
                </div>
              ))}
            </div>
            {!resource.outputs.length && (
              <p className="text-sm text-muted-foreground">No outputs on this page.</p>
            )}
          </ActivitySection>
        </>
      )}
      {resource.kind === "assets" && (
        <ActivitySection title="Media details">
          {resource.asset.kind !== "buffer" && resource.asset.state === "ready" ? (
            <MediaPreview projectId={projectId} environmentId={environmentId} recordingId={resource.asset.id} assetId={resource.asset.assetId} />
          ) : <p className="mb-4 text-sm text-muted-foreground">{resource.asset.kind === "buffer" ? "Shared buffers support DVR and clip creation. Open a ready recording or clip to preview saved media." : "Preview becomes available when this asset is ready."}</p>}
          <ActivityFields
            fields={[
              [
                "Kind",
                resource.asset.kind === "buffer" ? "Shared DVR / clip buffer" : resource.asset.kind,
              ],
              ["State", <ActivityStatus key="state" value={resource.asset.state} />],
              [
                "Stream",
                <Link
                  key="stream"
                  className="break-all underline"
                  href={link("streams", resource.asset.streamId)}
                >
                  {resource.asset.streamId}
                </Link>,
              ],
              ["Broadcast ID", resource.asset.broadcastId],
              ["Reported duration", formatDuration(resource.asset.durationSeconds)],
              ["Reported asset size", formatBytes(resource.asset.storedBytes)],
              ["Partial recording", resource.asset.partial ? "Yes" : "No"],
              ["Created", activityDate(resource.asset.createdAt)],
              ["Ended", activityDate(resource.asset.endedAt)],
              ["Expires", activityDate(resource.asset.expiresAt)],
            ]}
          />
          <ActivityError value={resource.asset.lastError} />
        </ActivitySection>
      )}
      {resource.kind === "sources" && (
        <ActivitySection title="External source">
          <ActivityFields
            fields={[
              ["Protocol", resource.source.protocol.toUpperCase()],
              ["State", <ActivityStatus key="state" value={resource.source.state} />],
              [
                "Stream",
                <Link
                  key="stream"
                  className="break-all underline"
                  href={link("streams", resource.source.streamId)}
                >
                  {resource.source.streamId}
                </Link>,
              ],
              ["Created", activityDate(resource.source.createdAt)],
              ["Updated", activityDate(resource.source.updatedAt)],
            ]}
          />
          <ActivityError value={resource.source.lastError} />
        </ActivitySection>
      )}
      {featureGroups.length > 0 && <ActivityFeatureSections groups={featureGroups} base={base} environmentId={environmentId} />}
      <ActivityPagination
        page={query.data.page}
        hasNext={(resource.hasNext || featureGroups.some(group => group.hasNext)) && query.data.page < 1000}
        href={(page) => `${link(view, resourceId)}&page=${page}`}
      />
      <div className="flex flex-wrap gap-4 text-sm">
        <Link
          className="underline"
          href={`${base}/usage?environment=${encodeURIComponent(environmentId)}`}
        >
          Usage for this environment
        </Link>
        <Link
          className="underline"
          href={`${base}/analytics?environment=${encodeURIComponent(environmentId)}`}
        >
          Connection analytics
        </Link>
      </div>
    </div>
  );
}
