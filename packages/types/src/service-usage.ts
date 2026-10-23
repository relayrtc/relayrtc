export type ServiceUsageCategory =
  | "sources"
  | "broadcasts"
  | "viewers"
  | "recordings"
  | "clips"
  | "dvr"
  | "mixers"
  | "external-sources";
export type ServiceUsageCoverage = "observed" | "estimated" | "partial" | "unavailable";
export type ServiceUsageResource =
  "stream" | "broadcast" | "recording" | "clip" | "dvr" | "mixer" | "external-source";

const sources: Record<ServiceUsageCategory, string> = {
  sources: "Fenced source worker progress and gateway/media counters",
  broadcasts: "Fenced broadcast output job observations",
  viewers: "Durable origin HTTP delivery intents, completion and activity observations",
  recordings: "Recording finalization observations, origin delivery and physical object lifetimes",
  clips:
    "Clip finalization observations, origin delivery and separately materialized object lifetimes",
  dvr: "DVR origin delivery and shared buffer physical object lifetimes",
  mixers: "Fenced compositor frame, fresh-input and applied-program observations",
  "external-sources": "Fenced external source worker counters",
};
const metric = (
  category: ServiceUsageCategory,
  unit: "seconds" | "bytes" | "byte-seconds" | "frames" | "count" | "viewers",
  attribution: "interval" | "event" | "gauge" | "peak",
  definition: string,
) => ({
  category,
  unit,
  attribution,
  aggregation: attribution === "peak" ? "peak" : attribution === "gauge" ? "gauge" : "sum",
  definition,
  source: sources[category],
  pricing: "unpriced" as const,
});

export const serviceUsageDefinitions = {
  sourceSeconds: metric(
    "sources",
    "seconds",
    "interval",
    "Source program progress observed by the gateway; not participant time.",
  ),
  sourceEncodeSeconds: metric(
    "sources",
    "seconds",
    "interval",
    "Encoded media clock progress from FFmpeg; not CPU seconds or connected time.",
  ),
  sourceRemuxSeconds: metric(
    "sources",
    "seconds",
    "interval",
    "Observed media clock progress of a copy-only source pipeline; current source pipelines encode.",
  ),
  sourceComposeFrames: metric(
    "sources",
    "frames",
    "event",
    "Frames actually submitted by the source compositor, including fallback frames.",
  ),
  roomExportBytes: metric(
    "sources",
    "bytes",
    "event",
    "SFU-to-source export hop; included in reported SFU egress, never unique viewer traffic. Do not add it again to the SFU total.",
  ),
  externalIngressBytes: metric(
    "sources",
    "bytes",
    "event",
    "External publisher-to-gateway ingress hop.",
  ),
  programBytes: metric(
    "sources",
    "bytes",
    "event",
    "Encoder-to-gateway program hop, not viewer egress.",
  ),
  outputSeconds: metric(
    "broadcasts",
    "seconds",
    "interval",
    "Observed successful output activity; summed per output, not per broadcast.",
  ),
  outputReservationSeconds: metric(
    "broadcasts",
    "seconds",
    "interval",
    "Lease-bounded allocated output capacity, including waiting and failed work.",
  ),
  externalOutputBytes: metric(
    "broadcasts",
    "bytes",
    "event",
    "Observed bytes written by external output jobs; destination receipt is not proven.",
  ),
  externalTranscodeSeconds: metric(
    "broadcasts",
    "seconds",
    "interval",
    "Lease-bounded live output wall time under a transcode profile; excludes copy-only outputs and is not CPU time.",
  ),
  viewerSeconds: metric(
    "viewers",
    "seconds",
    "interval",
    "Estimated activity between successive completed media responses at most 30 seconds apart, per grant and resource; not watched time.",
  ),
  peakConcurrentViewers: metric(
    "viewers",
    "viewers",
    "peak",
    "Peak overlap of observed viewer activity intervals; recomputed across the requested scope.",
  ),
  liveDeliveryBytes: metric(
    "viewers",
    "bytes",
    "event",
    "Completed live origin HTTP response body bytes, including manifests and repeats; excludes HEAD, errors, headers and TLS.",
  ),
  recordingDeliveryBytes: metric(
    "recordings",
    "bytes",
    "event",
    "Completed recording origin response body bytes, including partial ranges and repeated downloads.",
  ),
  clipDeliveryBytes: metric(
    "clips",
    "bytes",
    "event",
    "Completed clip origin response body bytes, including partial ranges and repeated downloads.",
  ),
  dvrDeliveryBytes: metric(
    "dvr",
    "bytes",
    "event",
    "Completed DVR origin response body bytes; buffer ownership is counted separately.",
  ),
  abortedDeliveryBytes: metric(
    "viewers",
    "bytes",
    "event",
    "Body bytes handed to Node before an incomplete response; partial transport observation, excluded from successful delivery.",
  ),
  recordingProcessingSeconds: metric(
    "recordings",
    "seconds",
    "interval",
    "Lease-bounded observed finalization wall time, including unsuccessful attempts; not CPU time.",
  ),
  clipProcessingSeconds: metric(
    "clips",
    "seconds",
    "interval",
    "Lease-bounded observed clip finalization wall time, including unsuccessful attempts; not nominal clip duration.",
  ),
  recordingFinalizations: metric(
    "recordings",
    "count",
    "event",
    "Successfully committed recording finalizations, deduplicated by resource and fence.",
  ),
  clipFinalizations: metric(
    "clips",
    "count",
    "event",
    "Successfully committed clip finalizations, deduplicated by resource and fence.",
  ),
  mixerRenderSeconds: metric(
    "mixers",
    "seconds",
    "interval",
    "Observed wall time with newly submitted compositor frames, including failed program attempts.",
  ),
  mixerProgramSeconds: metric(
    "mixers",
    "seconds",
    "interval",
    "Observed program progress for a healthy applied mixer revision.",
  ),
  mixerInputSeconds: metric(
    "mixers",
    "seconds",
    "interval",
    "Fresh input media observed during render intervals; excludes lost inputs, estimated at heartbeat granularity.",
  ),
  mixerFrames: metric(
    "mixers",
    "frames",
    "event",
    "New compositor frames reported for the fenced render session.",
  ),
  externalFetchBytes: metric(
    "external-sources",
    "bytes",
    "event",
    "Bytes fetched by external source workers; distinct from gateway ingress.",
  ),
  externalProcessingSeconds: metric(
    "external-sources",
    "seconds",
    "interval",
    "Observed external-source worker processing progress, including attempts.",
  ),
  recordingStoredBytes: metric(
    "recordings",
    "bytes",
    "gauge",
    "Committed recording object bytes retained at the end of the window.",
  ),
  recordingStorageByteSeconds: metric(
    "recordings",
    "byte-seconds",
    "interval",
    "Integral of retained committed recording object bytes over the window.",
  ),
  clipStoredBytes: metric(
    "clips",
    "bytes",
    "gauge",
    "Separately materialized clip objects retained at the end of the window; shared input buffers excluded.",
  ),
  clipStorageByteSeconds: metric(
    "clips",
    "byte-seconds",
    "interval",
    "Integral of separately materialized clip object bytes over the window.",
  ),
  bufferStoredBytes: metric(
    "dvr",
    "bytes",
    "gauge",
    "Shared DVR and clip buffer object bytes, counted once by physical owner.",
  ),
  bufferStorageByteSeconds: metric(
    "dvr",
    "byte-seconds",
    "interval",
    "Integral of shared buffer object bytes, counted once irrespective of pins.",
  ),
} as const;

export type ServiceUsageMetric = keyof typeof serviceUsageDefinitions;
export type ServiceUsageMetrics = Record<ServiceUsageMetric, number>;
export const serviceUsageRules = {
  window:
    "UTC [startedAt, endedAt); intervals clipped proportionally, byte/frame/count events attributed to occurrence time, stored bytes are end-of-window gauges.",
  identity:
    "Producer + resource + run + generation/fence + sequence. Retry replaces no data. Explicit revision-checked corrections retain the previous measurement and operator identity. Late and corrected samples are read directly, without stale aggregate caches.",
  delivery:
    "Origin observations only. CDN/cache bypass is unavailable without an authoritative delivery integration. Completion proves server response completion, not playback or client receipt.",
  viewers:
    "A grant alone produces no viewer activity. Successful non-manifest media responses establish activity; grant renewal starts a separate identity. Shared grants cannot identify individual humans.",
  storage:
    "Committed immutable physical objects only; pending uploads and origin caches are outside retained-asset storage. Historical deleted objects retain ownership and removal time.",
  coverage:
    "Historical activity before journal activation is unavailable; no measurements are backfilled from lifetime counters. Active heartbeat intervals and partial transport observations remain partial or estimated.",
  pricing:
    "All measurements are unpriced. Never sum overlapping service hops into unique end-to-end traffic or convert these measurements into charges without an explicit pricing policy.",
} as const;
