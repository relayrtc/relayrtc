# Docker deployment

Use [Install RelayRTC](https://docs.relayrtc.com/self-hosting) for the standard release installation. Calls, streaming workers, the ingest gateway and private storage are included together.

## Configuration

From a full source checkout with Node.js 22 or newer:

```sh
pnpm env:configure
```

This prepares `.env`, generates missing call/streaming secrets and writes the private `.streaming` monitoring files. Fill the provider credentials and review public addresses before startup. See [environment configuration](../configuration/README.md).

## Source builds

```sh
pnpm docker:up
```

This single command prepares configuration, builds the complete stack, runs database/storage initialization and waits for service health. It includes streaming automatically.

The management commands select the same complete configuration:

```sh
pnpm docker:config
pnpm docker:status
pnpm docker:logs
pnpm docker:down
```

The starter exposes console 3002, API 8080, signaling 8081, media readiness 8083, host PostgreSQL 5433 and RTMP ingest 1935. Browser media, TURN and WHIP also need their configured TCP/UDP ranges. Local TURN TLS uses a self-signed certificate and is not advertised by default.

## Release images

Follow the [installation guide](https://docs.relayrtc.com/self-hosting#4-create-your-settings-file) to prepare settings without host Node.js. Run these commands individually after filling provider credentials:

```sh
docker compose --env-file .env -f docker-compose.yml -f docker-compose.streaming.yml -f docker-compose.release.yml -f docker-compose.streaming.release.yml config --quiet
docker compose --env-file .env -f docker-compose.yml -f docker-compose.streaming.yml -f docker-compose.release.yml -f docker-compose.streaming.release.yml pull
docker compose --env-file .env -f docker-compose.yml -f docker-compose.streaming.yml -f docker-compose.release.yml -f docker-compose.streaming.release.yml up -d --no-build --wait
```

All four files are part of the standard installation. The release overrides select images while retaining the service commands and limits. Verify the tag and registry availability first.

## Maintenance

Drain calls, broadcasts and streaming work before shutdown. Use the same Compose files as startup. Keep database, storage and control services available while cleanup runs. A migration failure must leave application services stopped; returning to an older image does not undo migrations.

Normal shutdown preserves named volumes. Source checkouts use `pnpm docker:down`; release installations use the four-file configuration with `down`. Do not remove volumes during routine maintenance.

Service health is not media acceptance. Verify calls, TURN, ingest/playback, recording, access control and recovery before admitting production traffic.
