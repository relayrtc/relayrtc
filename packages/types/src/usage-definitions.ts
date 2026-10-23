import type { UsageMetrics } from "./usage.js";

export type UsageMetricName = keyof UsageMetrics | "activeTurnAllocations";
export type UsageAuthority = "authoritative" | "estimated";
export type UsageAggregation =
  "sum" | "union_seconds" | "count" | "peak" | "time_weighted_average" | "derived" | "gauge";

export interface UsageMetricDefinition {
  readonly unit: "seconds" | "minutes" | "bytes" | "count" | "participants";
  readonly aggregation: UsageAggregation;
  readonly integer: boolean;
  readonly definition: string;
  readonly source: string;
}

export const usageAccountingRules = {
  dimensions:
    "Preserve organization, project, environment, room and region from the owning server resource; unknown region is null, never an invented location.",
  intervals:
    "Use UTC half-open intervals [start, end), retain fractional seconds and clip to the requested window. A reconnect gap contributes no participant or signaling connection duration.",
  media:
    "Union simultaneous tracks by scoped participant and media category before summing participants. Audio and video are separate categories and must not be summed as total participant duration.",
  buckets:
    "Split durations at UTC calendar bucket boundaries. Attribute instantaneous counts and byte deltas to occurredAt; bytes without interval observations cannot be redistributed precisely across earlier buckets.",
  peaks:
    "Merge overlapping intervals per scoped subject, group starts and ends at identical timestamps before calculating concurrency, and recompute peaks at the requested scope instead of summing child peaks.",
  averages:
    "Average concurrent participants equals participantSeconds divided by the full window duration, including idle time. Recompute from duration and window length, never average child averages.",
  lateEvents:
    "Use occurrence time rather than ingestion time. Late or corrected events invalidate their affected buckets and retained parent rollups; retries retain the original sample identity and occurrence time.",
  authority:
    "Server-observed lifecycle intervals and native counters are authoritative within their measured coverage. Client TURN reports are estimates. Missing authoritative observations mean unavailable or partial coverage, not proven zero usage.",
  network:
    "SFU and TURN bytes describe different service hops. The same relayed packet may contribute to both services; their sum is service-hop traffic, not unique end-to-end transfer. Preserve native counter coverage; do not infer transport or encryption overhead that the counter does not observe.",
  counters:
    "Persist nonnegative deltas from cumulative counters with stable source identities. Counter resets establish a new baseline; never record a negative delta or count a lifetime total again.",
  recovery:
    "Close abandoned intervals at the last supported liveness boundary. A lease-expiry closure is a bounded recovery estimate and must not extend activity to the later reconciliation time.",
  optionalFeatures:
    "Room participant metrics retain their existing semantics. Room export bytes contribute to reported SFU egress and remain itemized under serviceUsageDefinitions. Other streaming and retained-asset observations stay separate.",
} as const;

export const usageMetricDefinitions = {
  participantSeconds: {
    unit: "seconds",
    aggregation: "union_seconds",
    integer: false,
    definition:
      "Connected room time, unioned per scoped participant across sessions; exclude reconnect and disconnected gaps.",
    source:
      "Retained participant connection intervals, clipped by participant leave and room termination.",
  },
  participantMinutesDerived: {
    unit: "minutes",
    aggregation: "derived",
    integer: false,
    definition:
      "participantSeconds / 60; round only for presentation, never store independently as an additive metric.",
    source: "Canonical participantSeconds.",
  },
  audioParticipantSeconds: {
    unit: "seconds",
    aggregation: "union_seconds",
    integer: false,
    definition:
      "Time with at least one active audio or screen_audio publication per participant; simultaneous microphone and screen audio count once. A paused publication is inactive; silence alone does not stop an active publication.",
    source: "Native media publication lifecycle, intersected with connected participant intervals.",
  },
  videoParticipantSeconds: {
    unit: "seconds",
    aggregation: "union_seconds",
    integer: false,
    definition:
      "Time with at least one active camera_video or screen_video publication per participant; simultaneous camera and screen video count once.",
    source: "Native media publication lifecycle, intersected with connected participant intervals.",
  },
  sfuIngressBytes: {
    unit: "bytes",
    aggregation: "sum",
    integer: true,
    definition:
      "Nonnegative native producer bytesReceived deltas observed at the SFU, counted once per producer observation.",
    source: "mediasoup producer statistics.",
  },
  sfuEgressBytes: {
    unit: "bytes",
    aggregation: "sum",
    integer: true,
    definition:
      "Nonnegative native consumer byte deltas sent by the SFU to RTC subscribers and room-to-stream exports; fan-out counts each consumer once. Itemized roomExportBytes are included in this total.",
    source: "mediasoup consumer statistics and retained room-export usage observations.",
  },
  turnIngressBytes: {
    unit: "bytes",
    aggregation: "sum",
    integer: true,
    definition:
      "Bytes entering TURN, summed across client-facing received and peer-facing received allocation counters; keep interfaces distinct before adding.",
    source:
      "Project-attributed native coturn log deltas, deduplicated by process source and log offset. Browser estimates are excluded.",
  },
  turnEgressBytes: {
    unit: "bytes",
    aggregation: "sum",
    integer: true,
    definition:
      "Bytes leaving TURN, summed across client-facing sent and peer-facing sent allocation counters; never infer authoritative relay traffic from SFU bytes.",
    source:
      "Project-attributed native coturn log deltas, deduplicated by process source and log offset. Browser estimates are excluded.",
  },
  turnRelaySeconds: {
    unit: "seconds",
    aggregation: "union_seconds",
    integer: false,
    definition:
      "Sum live allocation intervals by unique allocation identity. Simultaneous distinct allocations each accrue time; refreshes do not create new sessions.",
    source: "Project-attributed coturn allocation creation, refresh, expiry and closure ledger.",
  },
  turnSessions: {
    unit: "count",
    aggregation: "count",
    integer: true,
    definition:
      "Count successful unique TURN allocation creations in the window. A replacement allocation is new; refresh, permission and channel binding operations are not sessions.",
    source:
      "Project-attributed coturn allocation creation ledger; an active-allocation gauge cannot substitute.",
  },
  activeTurnAllocations: {
    unit: "count",
    aggregation: "gauge",
    integer: true,
    definition:
      "Number of live TURN allocations at an instant. Do not sum gauge samples or report them as cumulative turnSessions.",
    source:
      "Live coturn allocation inventory; aggregate monitoring without project attribution is node-scoped only.",
  },
  signalingConnections: {
    unit: "count",
    aggregation: "count",
    integer: true,
    definition:
      "Count accepted authenticated WebSocket upgrades, including resumed connections; exclude rejected upgrades. A participant session may own more than one connection over its lifetime.",
    source: "Signaling connection-open lifecycle events.",
  },
  signalingConnectionSeconds: {
    unit: "seconds",
    aggregation: "union_seconds",
    integer: false,
    definition:
      "Sum connected WebSocket intervals per connection identity; exclude recovery grace periods and reconnect gaps.",
    source: "Signaling connection-open/close intervals with durable ownership boundaries.",
  },
  signalingMessagesIn: {
    unit: "count",
    aggregation: "sum",
    integer: true,
    definition:
      "Count complete application data messages admitted by signaling, including malformed protocol envelopes after frame admission; exclude control frames, oversized frames and rate-rejected frames.",
    source: "Server signaling ingress counters and idempotent usage samples.",
  },
  signalingMessagesOut: {
    unit: "count",
    aggregation: "sum",
    integer: true,
    definition:
      "Count successfully written application data messages per destination. A broadcast to N destinations counts N successful writes; queueing alone is not delivery. Exclude ping, pong and close frames.",
    source: "Successful server WebSocket data writes and idempotent usage samples.",
  },
  roomsCreated: {
    unit: "count",
    aggregation: "count",
    integer: true,
    definition:
      "Count unique canonical room creations whose createdAt lies in the window, including never-started rooms.",
    source: "Retained room creation lifecycle.",
  },
  roomsStarted: {
    unit: "count",
    aggregation: "count",
    integer: true,
    definition:
      "Count a room's first transition to active in the window; subsequent joins and resumes do not start it again.",
    source: "Retained room startedAt and room-start lifecycle.",
  },
  roomSeconds: {
    unit: "seconds",
    aggregation: "union_seconds",
    integer: false,
    definition:
      "Sum each room's active interval from first start to end or failure. Empty time in an active room counts; a created but never-started room contributes zero.",
    source: "Retained room start, end and failure lifecycle.",
  },
  peakConcurrentRooms: {
    unit: "count",
    aggregation: "peak",
    integer: true,
    definition:
      "Maximum number of simultaneously active distinct rooms in the requested scope and window; not the sum of project or bucket peaks.",
    source: "Canonical room active intervals.",
  },
  peakConcurrentParticipants: {
    unit: "participants",
    aggregation: "peak",
    integer: true,
    definition:
      "Maximum simultaneous connected scoped participants after merging their overlapping sessions; not the number of sessions or the sum of child peaks.",
    source: "Canonical connected participant intervals.",
  },
  averageConcurrentParticipants: {
    unit: "participants",
    aggregation: "time_weighted_average",
    integer: false,
    definition:
      "participantSeconds / windowSeconds over the full requested window; zero for a nonempty window with no connected activity.",
    source: "Canonical participantSeconds and requested window boundaries.",
  },
  screenShareSeconds: {
    unit: "seconds",
    aggregation: "union_seconds",
    integer: false,
    definition:
      "Time with at least one active screen_video publication per participant. Multiple screen video tracks count once; screen audio alone does not start this duration.",
    source:
      "Native screen-video publication lifecycle, intersected with connected participant intervals.",
  },
  screenShareIngressBytes: {
    unit: "bytes",
    aggregation: "sum",
    integer: true,
    definition:
      "SFU ingress byte deltas for screen_video and screen_audio producers; a subset of sfuIngressBytes, never an additional total.",
    source: "Native producer statistics with server track-type ownership.",
  },
  screenShareEgressBytes: {
    unit: "bytes",
    aggregation: "sum",
    integer: true,
    definition:
      "SFU egress byte deltas for screen_video and screen_audio consumers; a subset of sfuEgressBytes, including subscriber fan-out.",
    source: "Native consumer statistics with server track-type ownership.",
  },
} as const satisfies Record<UsageMetricName, UsageMetricDefinition>;

export const usageMetricAliases = {
  messagesIn: "signalingMessagesIn",
  messagesOut: "signalingMessagesOut",
} as const satisfies Record<string, UsageMetricName>;

export const usageReportingCompatibility = {
  legacyBytes:
    "Historical reporting accepts previously stored fractional byte quantities without flooring or rewriting them. New authoritative SFU samples require whole bytes; legacy numeric acceptance does not certify measurement authority.",
  messageNames:
    "Existing reporting responses retain messagesIn/messagesOut; these alias signalingMessagesIn/signalingMessagesOut without changing their units or values.",
  connectionCount:
    "Reporting signalingConnections counts durable connection-open events, including resumes. Legacy coverage is limited to retained connection intervals; migration cannot reconstruct previously purged connection starts.",
  mediaDurations:
    "Existing media samples contain unioned duration deltas at observation time, not complete per-participant publication intervals. Precise bucket splitting and connected-interval intersection require the subsequent sampling and lifecycle phases.",
  turnTraffic:
    "TURN totals accept only trusted coturn allocation observations. Legacy browser estimates are excluded. Relay duration ends at the last confirmed observation; missing closure or collection coverage remains partial or unavailable.",
} as const;

export const usageMediaDurationMetrics = {
  audio: ["audioParticipantSeconds"],
  screen_audio: ["audioParticipantSeconds"],
  camera_video: ["videoParticipantSeconds"],
  screen_video: ["videoParticipantSeconds", "screenShareSeconds"],
} as const;

export function canonicalUsageMetric(name: string): UsageMetricName {
  if (Object.hasOwn(usageMetricAliases, name))
    return usageMetricAliases[name as keyof typeof usageMetricAliases];
  if (Object.hasOwn(usageMetricDefinitions, name)) return name as UsageMetricName;
  throw new Error(`Unknown usage metric: ${name}`);
}
