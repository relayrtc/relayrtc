# Changelog

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
