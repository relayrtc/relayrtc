# Environment configuration

The root `.env.example` contains the starter settings for the complete calls and streaming installation. Configuration preparation merges streaming settings automatically and generates missing credentials and private monitoring files.

| File | Use |
| --- | --- |
| `../../.env.example` | Starter addresses, provider credentials and generated infrastructure secrets |
| `streaming.env.example` | Streaming credentials and public addresses, merged automatically |
| `advanced.env.example` | Optional service limits and overrides consumed by Compose |

## Prepare configuration

From the repository root, with Node.js 22 or newer:

```sh
pnpm env:configure
```

The equivalent command is `node scripts/configure-env.mjs`. For a Docker-only release installation, use the [setup image](https://docs.relayrtc.com/self-hosting). Its browser wizard writes a local installation folder without a source checkout. Start the generated stack with Docker Compose afterward.

Preparation creates or completes `.env` and prepares `.streaming/worker-key`, `.streaming/gateway-key` and the certificate mount directory. It starts no services and applies no migrations. `pnpm docker:up` performs the same preparation before building and starting all services.

Existing release versions, URLs, credentials and unknown settings are preserved. Missing infrastructure secrets are generated independently; repeating preparation does not rotate them. An older `RELAYRTC_STREAMING_ENABLED=false` setting is changed to `true`, because the standard installation includes streaming.

The setup generates PostgreSQL, authentication, participant-signing, internal-control, TURN, Grafana, webhook-encryption, streaming signing/control, destination-encryption and storage credentials. Encryption keys are standard base64-encoded 32-byte values. Gateway/worker secrets use URL-safe encoding. Keep original encryption keys with your backups.

GitHub and Google OAuth providers are optional. Configure a complete credential pair for each enabled provider. Resend is optional for local and public deployments. Without a sender, email/password signup skips email verification and email-dependent actions are unavailable. With a sender configured and no explicit verification override, verification is enabled. See [sign-in and email setup](https://docs.relayrtc.com/guides/self-hosting-authentication).

Keep `.env` and `.streaming` private. On Windows, restrict their permissions to your account and Docker. Do not replace an existing `.env` with a template. Copy only individual advanced overrides you need.

## Public and private addresses

The starter uses localhost and does not configure a public TLS proxy. A VPS deployment needs reachable console/API/signaling origins, allowed browser origins, announced media/TURN addresses and streaming public origins. Internal Docker names for the database, API control, gateway, workers and storage stay private.

Streaming defaults are derived from `API_PORT`, `SIGNALING_PORT` and allowed browser origins when empty. Changing a base port later does not overwrite an existing streaming origin: update it explicitly. `STREAMING_SOURCE_ALLOWED_HOSTS` is an exact public-host allowlist; empty disables external HLS pulls.

Local TURN defaults omit `turns:` because the generated certificate is self-signed. Configure trusted certificates before advertising TURN TLS. See [public hosting](https://docs.relayrtc.com/guides/self-hosting-operations#public-hosting-and-ports) and [streaming access](https://docs.relayrtc.com/guides/streaming-operations#configure-public-access).

Compose supplies container database URLs. The generated host-tooling `DATABASE_URL` is separate. Changing a database password in `.env` does not update credentials in an existing database volume.

Internal addresses, receiver IPs and fixed port mappings are topology choices in Compose. Adding their service environment names to `.env` does not override them automatically; topology changes require an explicit Compose override.

## Advanced service configuration

`advanced.env.example` lists overrides forwarded by the supplied Compose files, including request limits, usage retention, proxy trust, media capacity, worker admission, recording storage, schedules, clips, DVR and mixers. Admission limits do not provision CPU, memory or extra workers.

Managed TURN is a separate deployment configuration. The API supports `TURN_AUTH_MODE=managed`, `TURN_REALM`, `TURN_ADMIN_HOST`, `TURN_ADMIN_PORT` and `TURN_ADMIN_PASSWORD`, plus accounting access. The supplied coturn service uses shared-secret REST authentication and does not enable its admin interface. Setting only these variables in the base `.env` does not establish managed mode; configure a compatible TURN service and explicit API environment override together.

## Start and maintain the stack

`pnpm docker:up` starts all 16 services, including the one-time database and storage setup services. `pnpm docker:status`, `pnpm docker:logs`, `pnpm docker:config` and `pnpm docker:down` use the same source configuration.

The older `env:configure:streaming` and `docker:up:streaming` names remain compatibility aliases for the standard commands. They are not separate installation paths.

Release commands use these files in order: `docker-compose.yml`, `docker-compose.streaming.yml`, `docker-compose.release.yml`, `docker-compose.streaming.release.yml`. Use matching published images and `--no-build`. The templates target Docker Hub images at 0.1.4; a template version does not establish registry availability.
