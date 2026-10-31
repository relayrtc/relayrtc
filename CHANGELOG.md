# Changelog

## 0.1.4

### Phase 1 - room roles, permissions and audit logs

- Add versioned participant permission ceilings, host transfer, moderator controls, live publication revocation and room-scoped audit history.
- Add migration `0045_room_access`, the `participants:write` scope, browser capabilities, React access hooks, Node management methods and matching documentation.

### Phase 2 - room admission, invitations and timed rooms

- Add persisted room locks, deadlines, warning snapshots and durable termination recovery.
- Add expiring identity-bound invitations, one-time secrets, bounded use counts, idempotent redemption and admission-time revocation checks.
- Add migration `0046_room_lifecycle`, the `rooms:write` scope, SDK controls and matching documentation.

### Phase 3 - speakers, activity and push-to-talk

- Add microphone speaker detection, dominant-speaker hysteresis, expiring observations, privacy preferences and browser activity states.
- Add migration `0047_room_activity`, browser push-to-talk, React hooks and Node observation/policy methods.
- Serialize media observation timestamps for PostgreSQL and deliver activity independently of the signaling housekeeping timer.
- Stream console activity over an authenticated feed, reduce session polling and share rate-limit cooldowns between related reads.
- Match console settings and dialogs, add room audit/invitation pages and animate per-participant last-spoke counters while the overview is open.

### Release compatibility

Use matching 0.1.4 SDKs, API, signaling, media and migrator builds. Apply migrations 0045 through 0047 before updated services. Older strict protocol clients require a coordinated upgrade. REST `/v1` and realtime wire version 1 remain unchanged. Installer metadata, Docker Hub image defaults and package candidates target 0.1.4. Preparing these files does not publish artifacts.

## 0.1.3

- Add the Docker-only browser setup wizard using the console design and Docker Hub distribution.
- Generate one configuration for rooms and streaming, preserve infrastructure credentials and allow optional email/OAuth integrations to be skipped.
- Add selective image publishing and improve generated Compose mounts and installer diagnostics.

## 0.1.2

- Add ROOM, WHIP and RTMP stream sources, broadcast runs, external destinations and scheduled events.
- Add private live playback, recordings and asset grants, clips, rolling buffers, DVR, server-rendered mixers and guest stages.
- Add identity-preserving participant-token renewal, playback readiness and service-usage reports with explicit coverage and measurement units.
- Prevent source accounting from deadlocking with stream stop, deletion and ingest credential rotation.
- Align the six public SDK packages at 0.1.2, with portable dependencies, publication documents and prepack builds.
- Start calls and streaming together by default, generate their credentials and monitoring files automatically, and use the same complete stack for startup, logs, status and shutdown.
- Separate advanced settings and map all streaming worker roles to release images.
- Rewrite getting-started, realtime, streaming, API/SDK reference and self-hosting documentation.

### Upgrading from 0.1.1

Use matching application, migrator and worker images. Migrations 0032–0044 add the new resources and usage journal, including existing-media initialization. Back up metadata, retained media and original signing/encryption keys before upgrading. Apply migrations through the release migrator and preserve cleanup/control services while draining jobs. See the self-hosting guide for the complete upgrade procedure.

REST `/v1` and realtime wire version 1 remain separate from package versions. New SDK methods require the matching API capabilities; version alignment alone does not establish a successful deployed media path.
