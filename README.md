<img width="2172" height="724" alt="GithubBanner" src="https://github.com/user-attachments/assets/0cc439f5-cf28-4003-a8ac-a1b2dff96115" />

# What is Relayrtc?

RelayRTC is open-source realtime communication infrastructure for developers. It is designed to provide stable APIs and SDKs for voice, video, rooms, screen sharing, messaging, presence. Built on top of WebRTC.

## Development prerequisites

- Node.js 22 or newer
- pnpm 10 or newer
- Go 1.24 or newer
- Docker with the Compose plugin

## Getting started

The Docker-only installer starts rooms, streaming, storage and monitoring together. Once the `0.1.3` installer and matching service images are published, run:

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v relayrtc-config:/setup/state ghcr.io/relayrtc/setup:0.1.3
```

Open `http://localhost:3002` and create your account. Local startup generates secrets automatically and needs no OAuth/email credentials or host Node.js, pnpm, npm, Bun, Go or Git. This installer is a local release candidate, not a claim of registry availability. See [Install RelayRTC](https://docs.relayrtc.com/self-hosting) for platform requirements, operations and public hosting.

To build from this source checkout, install dependencies and prepare your settings:

```bash
pnpm install
pnpm env:configure
```

The preparation command generates the call and streaming credentials and private monitoring files. Local email/password signup works without external providers. Configure optional GitHub/Google sign-in and email delivery using [sign-in and email setup](https://docs.relayrtc.com/guides/self-hosting-authentication). Public console addresses require email delivery. Keep the generated keys. Then build and start the complete local stack:

```bash
pnpm docker:up
```

This starts calls and streaming together, including the workers, ingest gateway and private storage. Open the console at `http://localhost:3002`. The default API base is `http://localhost:8080/v1`, and signaling is `ws://localhost:8081/v1/connect`.

Use `pnpm docker:logs`, `pnpm docker:status`, and `pnpm docker:down` to operate the stack.

For development directly on the host please use :

```bash
pnpm install
pnpm build
pnpm test
```

Additional repository checks:

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test:e2e
```

## Available SDKs

| SDK | Package | GitHub | Documentation |
| --- | --- | --- | --- |
| React | [@relayrtc/react](https://www.npmjs.com/package/@relayrtc/react) | [react-sdk](https://github.com/relayrtc/react-sdk) | [React SDK](https://docs.relayrtc.com/reference/sdk/client/react/overview) |
| Node.js | [@relayrtc/node](https://www.npmjs.com/package/@relayrtc/node) | [node-sdk](https://github.com/relayrtc/node-sdk) | [Node SDK](https://docs.relayrtc.com/reference/sdk/server/node/overview) |
| JavaScript browser client | [@relayrtc/client](https://www.npmjs.com/package/@relayrtc/client) | [packages/client](https://github.com/relayrtc/relayrtc/tree/main/packages/client) | [Browser SDK](https://docs.relayrtc.com/reference/sdk/client/javascript/overview) |

## Supporting packages

| Package | Purpose | GitHub |
| --- | --- | --- |
| [@relayrtc/types](https://www.npmjs.com/package/@relayrtc/types) | Shared TypeScript domain contracts. | [packages/types](https://github.com/relayrtc/relayrtc/tree/main/packages/types) |
| [@relayrtc/validation](https://www.npmjs.com/package/@relayrtc/validation) | Runtime validation schemas for domain contracts. | [packages/validation](https://github.com/relayrtc/relayrtc/tree/main/packages/validation) |
| [@relayrtc/protocol](https://www.npmjs.com/package/@relayrtc/protocol) | Versioned realtime wire contracts. | [packages/protocol](https://github.com/relayrtc/relayrtc/tree/main/packages/protocol) |

See the [installation guide](https://docs.relayrtc.com/installation) and [quickstart](https://docs.relayrtc.com/quickstart) to build your first call.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Report security issues according to [SECURITY.md](SECURITY.md), not through a public issue.

## License

Licensed under the [Apache License 2.0](LICENSE).
