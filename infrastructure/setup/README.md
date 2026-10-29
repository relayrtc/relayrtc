# Docker-only setup

The setup image runs an automatic terminal installer against the operator's existing Linux Docker engine. It does not run Docker-in-Docker or require a host source checkout, package manager, browser wizard or administrator bootstrap account.

The initial candidate is **0.1.3**. A registry command becomes usable only after the setup image and matching application images are published. The publication workflow builds application images first and publishes setup afterward, targeting Linux AMD64 and ARM64.

## Build

From the repository root:

```sh
docker build --platform linux/amd64,linux/arm64 --file infrastructure/docker/setup.Dockerfile --build-arg RELAYRTC_VERSION=0.1.3 --tag relayrtc/setup:local .
```

This builds the installer, not the application images, and starts no RelayRTC services. Matching application images must be built/published separately before an actual installation. The build argument stamps `release.json`; runtime environment overrides cannot switch the bundled release accidentally.

## Entry point

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v relayrtc-config:/setup/state ghcr.io/relayrtc/setup:0.1.3
```

The configuration mount must be a writable named volume. Setup identifies its own mount through Docker inspection; keep the default container hostname. Docker Engine API 1.45+ is required for read-only volume subdirectory mounts. Use the actual Unix socket location for a rootless/custom engine.

## Modules

| File | Responsibility |
| --- | --- |
| `cli.mjs` | Install/resume, explicit upgrade, settings import/update, status/logs and lifecycle commands |
| `state.mjs` | Mount identity, private atomic writes, installation locking and dotenv input |
| `manifest.mjs` | Canonical four-file composition, controlled interpolation, literal-dollar escaping and volume-backed runtime configuration |
| `docker.mjs` | Docker subprocess execution with bounded captured output and cancellation |
| `release.json` | Bundled release identity, stamped during image build |

The image reuses [configuration generation](../../scripts/configure-env.mjs) and [streaming preparation](../../scripts/prepare-streaming.mjs). It generates one private `compose.json` using the existing four Compose definitions, removes source builds and substitutes read-only named-volume subdirectory mounts for gateway/monitoring bind files. Service containers do not receive the full configuration volume root.

Docker Compose's unexpanded JSON model is resolved against the saved dotenv settings, not arbitrary installer environment variables. Dollar signs are escaped when storing the final model so credentials and container-side health-check variables survive Compose's subsequent interpolation.

## State and failure behavior

Configuration and initialized infrastructure credentials persist across repeated runs. Separate data volumes retain PostgreSQL, object storage, Grafana, Prometheus and TURN accounting. Existing project containers or Compose-owned volumes require explicit original-configuration import. Upgrade checks existing stateful mounts and refuses PostgreSQL image changes rather than assuming database compatibility.

Setup acquires a configuration-volume lock. An interrupted owner's lock can be recovered only after Docker confirms its container stopped or disappeared; ambiguous or incomplete lock records require operator inspection. Lock recovery is serialized. The installer never automatically deletes application/data volumes.

Upgrade is explicit: operators first drain traffic and back up data, then invoke the target setup image with `upgrade`. Images are pulled before application services are stopped. Migration/startup failure leaves a nonzero exit status and recoverable state; configuration snapshots are not database backups or automatic schema rollback.

`configure` merges known dotenv settings from standard input and applies no running changes. Initialized infrastructure credentials cannot be rotated through this convenience command. `import-env` requires original core credentials and existing streaming credentials when streaming was enabled. `export-env` and `credentials` intentionally reveal sensitive output only on explicit operator request.

## Verification limits

Use syntax, formatting, lint, source compilation, image builds and Compose configuration inspection within the current no-tests rule. Do not infer working installation, migration, network routing, media or upgrade recovery from an image build. This implementation has not been exercised as a live deployment.
