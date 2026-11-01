# @relayrtc/media

Internal TypeScript media service for RelayRTC.

The service owns the mediasoup worker pool, assigns one router per room, creates participant
WebRTC transports, reports worker health, and enforces configured room and transport capacity.
The vendor-neutral `MediaEngine` contract keeps mediasoup out of RelayRTC's public interfaces.

```bash
pnpm --filter @relayrtc/media build
pnpm --filter @relayrtc/media start
```

The service listens on port `8082` by default and exposes:

```text
GET /health
GET /ready
GET /internal/v1/capacity
POST /internal/v1/rooms/:roomId
DELETE /internal/v1/rooms/:roomId
GET /internal/v1/rooms/:roomId/capabilities
POST /internal/v1/rooms/:roomId/transports
```

Each worker owns a WebRTC server and requires one TCP/UDP port beginning at `MEDIA_RTC_PORT`.
`MEDIA_RTC_MAX_PORT` must include at least `MEDIA_WORKERS` ports. Set
`MEDIA_RTC_ANNOUNCED_ADDRESS` to the media node address reachable by browser clients.

## Usage diagnostics

Set `MEDIA_USAGE_DIAGNOSTICS=true` when recreating the media service to enable the internal
`GET /internal/v1/rooms/:roomId/usage-diagnostics` endpoint. It is disabled by default.
Requests require a signed media-control token with room authority for that exact room,
method and path. Participant grants cannot read diagnostics.

## Adaptive video quality

Receive quality defaults to `auto`. The allocator selects the highest eligible spatial
layer within the subscriber's shared budget. Encoding heights come from source height
and encoding scale metadata, not RID names. Missing simulcast scale metadata leaves
the corresponding height unknown. Existing quality tier labels remain compatible,
while known dimensions enforce manual resolution ceilings.

The normal budget retains 15% capacity reserve and 64 Kbps per audio subscription
with a minimum 64 Kbps reserve. Spatial upgrades require another 10% of the candidate
layer bitrate, followed by three qualifying observations. This keeps a 4 Mbps video
upgrade with one audio track below mediasoup's usual 5.4 Mbps estimate ceiling,
at approximately 5.25 Mbps. Downgrades remain immediate at the allocation boundary.
Mediasoup can independently delay or downgrade actual forwarding.

Manual SDK quality preferences remain bandwidth-safe ceilings. Stale observations,
severe loss, excessive RTT or insufficient capacity retain the audio-only fallback.
This policy does not alter camera capture, frame rate or publisher encoding budgets.

Enabled usage diagnostics include producer scale metadata and consumer
`requestedQuality`, `availableLayers`, `allocatedLayer`, `preferredLayers`,
`forwardedLayer`, `budget`, upgrade progress and the native receive transport ID.
`selectedLayers` remains the actual mediasoup current layer for compatibility.
`forwardedLayer.estimatedHeight` is derived from encoding metadata, not a browser
decoded-frame observation. Paused consumers can retain a previously selected layer.
