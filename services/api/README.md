# RelayRTC REST API

The Fastify service exposes RelayRTC's versioned public API.

## Endpoints

- `GET /health` — process liveness
- `GET /ready` — database readiness
- `GET /v1` — authenticated API-key context
- `POST /v1/rooms` — create a room (`rooms:create`)
- `GET /v1/rooms` — list scoped rooms (`rooms:read`)
- `GET /v1/rooms/:roomId` — get a scoped room (`rooms:read`)
- `DELETE /v1/rooms/:roomId` — end a scoped room (`rooms:end`)
- `POST /v1/rooms/:roomId/tokens` — create a signed participant token (`tokens:create`)
- `GET /v1/rooms/:roomId/participants` — list room participants (`participants:read`)
- `GET /v1/rooms/:roomId/participants/:participantId` — get a participant (`participants:read`)
- `DELETE /v1/rooms/:roomId/participants/:participantId` — remove a participant (`participants:remove`)

All `/v1` routes require an API key in the `Authorization: Bearer <key>` header. The key determines the project and environment scope. Clients may also send `x-relayrtc-project-id` and `x-relayrtc-environment-id`; mismatched values are rejected.

Room listing accepts `limit`, `cursor`, and `status` query parameters. Ending a room preserves its historical record and is idempotent.

Participant tokens are short-lived HS256 JWTs scoped to one project, environment, room, and participant. Requests may choose permissions and a lifetime from 60 to 3,600 seconds; the default is 600 seconds with only `room:join` permission.

Participant listing accepts `limit`, `cursor`, and `status` (`active` or `left`) query parameters. Removing a participant records `leftAt`, preserves historical data, and is idempotent.

## Environment

`POST /v1/rooms/:roomId/tokens/renew` requires `tokens:create` and a body containing the current unexpired `participantToken`, its active `sessionId`, and optional `ttlSeconds` (60–3600; default 600). It returns a new token for the same identity and permissions. Renewal checks scoped tenant/room/session eligibility and rejects removed participants, expired tokens and streaming guest grants. Call it through an authenticated application backend and supply replacements to the browser `refreshToken` callback. `tokens.create` is not renewal.

- `DATABASE_URL` — required PostgreSQL connection URL
- `API_HOST` — listening address, defaults to `0.0.0.0`
- `API_PORT` — listening port, defaults to `8080`
- `API_LOG_LEVEL` — Pino log level, defaults to `info`
- `API_TRUST_PROXY` — whether proxy forwarding headers are trusted, defaults to `false`
- `PARTICIPANT_TOKEN_SIGNING_SECRET` — required signing secret of at least 32 characters
- `PARTICIPANT_TOKEN_KEY_ID` — signing key identifier, defaults to `participant-v1`
- `PARTICIPANT_TOKEN_ISSUER` — JWT issuer, defaults to `relayrtc-api`
- `PARTICIPANT_TOKEN_AUDIENCE` — JWT audience, defaults to `relayrtc-realtime`

## Temporary TURN credentials

`POST /v1/turn/credentials` creates short-lived TURN credentials using a secret API key with the `tokens:create` scope. The response contains browser-ready STUN and TURN ICE servers.

Credentials use coturn REST authentication and expire after the configured lifetime. Their username includes the project and environment scope, while `TURN_SHARED_SECRET` remains private to RelayRTC services.

- `TURN_SHARED_SECRET` — required coturn REST authentication secret of at least 32 characters
- `TURN_CREDENTIAL_TTL_SECONDS` — lifetime from 60 to 3,600 seconds, defaults to `600`
- `TURN_STUN_URLS` — comma-separated public STUN URLs
- `TURN_URLS` — comma-separated public TURN UDP, TCP, and TLS URLs
