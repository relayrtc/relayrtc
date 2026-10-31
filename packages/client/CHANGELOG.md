# Changelog

## 0.1.4

### Phase 3 - speakers, activity and push-to-talk

- Add `room.activity`, `activityChanged`, initial reporting preferences and `createPushToTalk`. Clear stale observations and silence capture on release, visibility/focus loss, disconnect, revocation and disposal.

### Phase 2 - room admission and lifecycle

- Add `room.lifecycle.current`, `get`, `update` and `lifecycleChanged` snapshots for lock, deadline and warning state. Export lifecycle and invitation types and the application-authorized `RoomInvitationBackend` callback contract.

### Phase 1 - room access

- Add `room.access`, versioned participant policy operations and `capabilitiesChanged` snapshots. Stop local media capture on publication revocation and consume updated join/resume capabilities.

## 0.1.2

- Add private live/VOD/DVR playback and application-backed broadcast, recording, clip, mixer, schedule, external-source and guest clients.
- Expose playback readiness, HLS configuration, credential renewal and bounded polling backoff.
