import { z } from "zod";
import { dtlsParametersSchema } from "./rtc.js";
import type { MediaControlAuthority } from "./media-control.js";
import type { ProtocolErrorCode } from "./error.js";

const identity = z.string().min(1).max(128).regex(/^\S+$/u);
const resourceId = z.string().min(1).max(256).regex(/^\S+$/u);
const parameters = z.record(z.string(), z.unknown());
const mediaType = z.enum(["audio", "camera_video", "screen_audio", "screen_video"]);
const owner = { participantId: identity };

export const rtcRuntimeRoomScopeSchema = z.object({
  projectId: identity,
  environmentId: identity,
  roomId: identity,
  mediaNodeId: identity,
  generation: identity,
}).strict();

export const rtcRuntimeScopeSchema = rtcRuntimeRoomScopeSchema.extend({
  participantId: identity,
  sessionId: identity,
  mediaParticipantId: identity,
}).strict().refine((scope) => scope.mediaParticipantId === scope.sessionId, {
  message: "Media ownership must be isolated by signaling session",
});

export const rtcRuntimeBodySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("room.create"), body: z.null() }).strict(),
  z.object({ operation: z.literal("room.close"), body: z.null() }).strict(),
  z.object({ operation: z.literal("capabilities.get"), body: z.null() }).strict(),
  z.object({ operation: z.literal("tracks.list"), body: z.null() }).strict(),
  z.object({ operation: z.literal("participant.remove"), body: z.null() }).strict(),
  z.object({ operation: z.literal("transport.create"), body: z.object({ ...owner, direction: z.enum(["send", "receive"]) }).strict() }).strict(),
  z.object({ operation: z.literal("transport.connect"), body: z.object({ ...owner, dtlsParameters: dtlsParametersSchema }).strict() }).strict(),
  z.object({ operation: z.literal("ice.restart"), body: z.object(owner).strict() }).strict(),
  z.object({ operation: z.literal("track.publish"), body: z.object({ ...owner, transportId: resourceId, kind: z.enum(["audio", "video"]), trackType: mediaType, rtpParameters: parameters }).strict() }).strict(),
  z.object({ operation: z.literal("track.subscribe"), body: z.object({ ...owner, transportId: resourceId, trackId: resourceId, rtpCapabilities: parameters }).strict() }).strict(),
  z.object({ operation: z.literal("track.pause"), body: z.null() }).strict(),
  z.object({ operation: z.literal("track.resume"), body: z.null() }).strict(),
  z.object({ operation: z.literal("track.remove"), body: z.null() }).strict(),
  z.object({ operation: z.literal("subscription.resume"), body: z.object(owner).strict() }).strict(),
  z.object({ operation: z.literal("subscription.remove"), body: z.object(owner).strict() }).strict(),
]);

export const rtcRuntimeCommandSchema = z.object({
  requestId: resourceId,
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
  path: z.string().regex(/^\/internal\/v1\/rooms\//u),
  scope: z.union([rtcRuntimeScopeSchema, rtcRuntimeRoomScopeSchema]),
  responseType: z.string(),
  request: rtcRuntimeBodySchema,
  metadata: parameters,
}).strict().superRefine((command, context) => {
  const body = command.request.body;
  const participantId = "mediaParticipantId" in command.scope ? command.scope.mediaParticipantId : undefined;
  if (command.request.operation !== "room.create" && command.request.operation !== "room.close" && command.request.operation !== "tracks.list" && participantId === undefined)
    context.addIssue({ code: "custom", message: "Participant operations require a joined session binding" });
  if (body && body.participantId !== participantId)
    context.addIssue({ code: "custom", message: "Media participant must match the trusted session binding" });
  if (command.request.operation === "track.publish" && command.request.body.kind !==
    (command.request.body.trackType === "audio" || command.request.body.trackType === "screen_audio" ? "audio" : "video"))
    context.addIssue({ code: "custom", message: "Media kind must match the published track type" });
  let parts: string[];
  try { parts = command.path.split("/").map(decodeURIComponent); } catch {
    context.addIssue({ code: "custom", message: "Invalid encoded media route" });
    return;
  }
  const rest = parts.slice(5);
  const idAt = (index: number) => resourceId.safeParse(rest[index]).success;
  const routes = {
    "room.create": ["POST", rest.length === 0, ""],
    "room.close": ["DELETE", rest.length === 0, ""],
    "capabilities.get": ["GET", rest.length === 1 && rest[0] === "capabilities", "rtc.capabilities"],
    "tracks.list": ["GET", rest.length === 1 && rest[0] === "tracks", ""],
    "transport.create": ["POST", rest.length === 1 && rest[0] === "transports", "rtc.transport.created"],
    "transport.connect": ["PATCH", rest.length === 2 && rest[0] === "transports" && idAt(1), "rtc.transport.connected"],
    "ice.restart": ["POST", rest.length === 3 && rest[0] === "transports" && idAt(1) && rest[2] === "restart-ice", "rtc.ice.restarted"],
    "track.publish": ["POST", rest.length === 1 && rest[0] === "tracks", "rtc.track.publish.accepted"],
    "track.subscribe": ["POST", rest.length === 1 && rest[0] === "subscriptions", "rtc.track.subscribe.accepted"],
    "track.pause": ["PATCH", rest.length === 5 && rest[0] === "participants" && rest[1] === participantId && rest[2] === "tracks" && idAt(3) && rest[4] === "pause", "rtc.track.control.accepted"],
    "track.resume": ["PATCH", rest.length === 5 && rest[0] === "participants" && rest[1] === participantId && rest[2] === "tracks" && idAt(3) && rest[4] === "resume", "rtc.track.control.accepted"],
    "track.remove": ["DELETE", rest.length === 4 && rest[0] === "participants" && rest[1] === participantId && rest[2] === "tracks" && idAt(3), "rtc.track.control.accepted"],
    "participant.remove": ["DELETE", rest.length === 2 && rest[0] === "participants" && rest[1] === participantId, ""],
    "subscription.resume": ["PATCH", rest.length === 3 && rest[0] === "subscriptions" && idAt(1) && rest[2] === "resume", "rtc.subscription.resumed"],
    "subscription.remove": ["DELETE", rest.length === 2 && rest[0] === "subscriptions" && idAt(1), "rtc.subscription.close.accepted"],
  } as const;
  const route = routes[command.request.operation];
  if (command.path.includes("?") || command.path.includes("#") || parts[4] !== command.scope.roomId || command.method !== route[0] || !route[1] || command.responseType !== route[2])
    context.addIssue({ code: "custom", message: "Media route and response must match the scoped operation" });
});

export type RtcRuntimeScope = z.infer<typeof rtcRuntimeScopeSchema>;
export type RtcRuntimeCommand = z.infer<typeof rtcRuntimeCommandSchema>;

export function rtcRuntimeAuthority(command: RtcRuntimeCommand): MediaControlAuthority {
  const { roomId } = command.scope;
  if (command.request.operation === "room.create" || command.request.operation === "room.close" || command.request.operation === "tracks.list") return { kind: "room", roomId };
  if (!("mediaParticipantId" in command.scope)) throw new Error("A joined session binding is required");
  const { mediaParticipantId: participantId, sessionId } = command.scope;
  switch (command.request.operation) {
    case "participant.remove": return { kind: "participant-cleanup", roomId, participantId };
    default: return { kind: "participant", roomId, participantId, sessionId };
  }
}

export const rtcRuntimePolicy = {
  version: 1,
  roomOwner: "database",
  sessionOwner: "signaling",
  placementOwner: "signaling-placement-repository",
  transportOwner: "media-session",
  publicTrackOwner: "signaling-resource-repository",
  allocation: "lazy-after-authenticated-join-before-first-rtc-response",
  placement: "one-media-node-per-room-incarnation",
  mediaParticipantIdentity: "sessionId",
  recovery: "preserve-binding-within-recovery-timeout",
  finalLeave: "remove-session-media-and-resource-bindings",
  roomEnd: "fence-new-operations-before-cleanup-on-assigned-node",
  unallocatedRoomEnd: "no-media-allocation-or-network-call",
  correlation: "public-request-id-is-preserved",
  idempotencyKey: ["sessionId", "requestId"],
  duplicateRequest: "replay-result-only-when-payload-fingerprint-matches",
  ambiguousMutationFailure: "reconcile-before-retry-never-blindly-repeat",
  ambiguousMutationRecovery: "invalidate-session-bindings-and-clean-up-session-media-before-renegotiation",
  placementFailure: "release-allocation-claim-and-return-temporarily_unavailable",
  nodeFailure: "invalidate-generation-and-renegotiate-never-reuse-transports",
  subscriptionStart: "paused-until-client-consumer-is-ready",
  subscriptionNegotiationTimeoutMs: 60_000,
  subscriptionFailure: "close-consumer-and-invalidate-binding",
  trackDiscovery: "room-scoped-snapshot-on-join-and-resume",
  eventDelivery: "ordered-room-journal-with-session-scoped-consumer-events",
  responseTranslation: "media-id-to-public-id-with-server-owned-track-metadata-and-timestamps",
  responseFields: { transportId: "transport.id", subscriptionId: "subscription.id", trackId: "public-track-binding.id", trackMetadata: "signaling-track-binding.metadata", producerId: "internal-only" },
  failureCodes: { forbidden: "forbidden", invalid: "invalid_message", unsupported: "invalid_message", unavailable: "temporarily_unavailable", requestConflict: "conflict" } satisfies Record<string, ProtocolErrorCode>,
  unsupportedOperations: ["data-track-publish", "track-pause", "track-resume"],
} as const;
