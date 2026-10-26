# Release preparation

A version bump is a candidate, not publication. Keep source, SDK packages, image roles and installation files aligned before creating a tag or publishing anything.

## Package ownership and order

| Package                | Source                          | Candidate version |
| ---------------------- | ------------------------------- | ----------------- |
| `@relayrtc/types`      | `packages/types`                | 0.1.2             |
| `@relayrtc/validation` | `packages/validation`           | 0.1.2             |
| `@relayrtc/protocol`   | `packages/protocol`             | 0.1.2             |
| `@relayrtc/client`     | `packages/client`               | 0.1.2             |
| `@relayrtc/react`      | Separate `react-sdk` repository | 0.1.2             |
| `@relayrtc/node`       | Separate `node-sdk` repository  | 0.1.2             |

Build and publish the first five in dependency order. Node has no runtime package dependencies but still requires acceptance against the target API. React's browser-client peer is `^0.1.2`; React 18.3.1 and 19 remain supported. The wire protocol and REST contract remain version 1 independently of npm versions.

## Prepare artifacts

Install locked dependencies, then build types, validation, protocol and client in order. Build Node/React from their own repositories using compatible dependencies. Each public package has a prepack build hook; do not publish stale build output.

Pack all six packages locally. Inspect their manifests, runtime/declaration entry points, license, README and changelog. Workspace dependencies must become published versions in the tarball; no `link:` or sibling `file:` dependency may remain. Keep the validated tarballs and their hashes outside source control and publish those exact files after approval.

Use isolated consumers with only the packed packages and public dependencies. Typecheck against React 18 and 19, bundle browser entry points without Node built-ins, import the Node package, and verify provider server rendering. Do not use source aliases or sibling SDK links as evidence of package acceptance.

The React lockfile may reference candidate tarball integrity before publication. If any packed dependency changes, regenerate its integrity from the final artifacts and repeat the frozen-lockfile/consumer checks. After publication, verify the registry bytes and perform a normal registry install.

## Images and installation

The image workflow builds eleven families: API, signaling, media, console, migrator, coturn, Prometheus, Grafana, streaming, streaming-storage and streaming-storage-init. The four streaming worker roles share the streaming image but retain distinct commands.

The standard installation includes calls and streaming. Source commands use `docker-compose.yml` plus `docker-compose.streaming.yml`; release commands also apply `docker-compose.release.yml` and `docker-compose.streaming.release.yml`, in that order. Configuration preparation generates all credentials and monitoring bind files by default.

Run `node scripts/check-release-config.mjs` with the Docker CLI. It renders both standard source/release combinations using generated temporary values and checks all 16 services, enabled streaming and image coverage. It does not start containers, pull images or establish image availability.

## Acceptance gates

Run `pnpm test:database` with `RELAYRTC_TEST_DATABASE_URL` pointing to a dedicated PostgreSQL database named `relayrtc_usage_test`. The database role must be able to create and drop the temporary databases used by migration rehearsals. This runs the reporting, retention, console proxy and stream-lock regression suites; CI provisions its own PostgreSQL instance for the same command. Never point these fixture tests at an existing installation.

Before publication, record results for:

- Source builds, typechecks and meaningful API, auth, signaling, media, worker and SDK tests.
- Packed-package installation, exports, declarations, browser bundling and supported React versions.
- Documentation, navigation, examples, deployment configuration and package/image version alignment.
- A fresh install and upgrade of existing metadata/media from the prior supported release, including migrations, backup restoration and retained assets.
- Real calls, token renewal, TURN routing, webhook verification, stream ingest/playback, recording, clips, DVR, destinations, schedules, mixers and guest revocation against matched services.

Skipped database tests, mocked media engines, configuration rendering and SSR are not live-media or upgrade acceptance. If Docker or required providers are unavailable, leave those gates pending. Do not mark the release ready from unit tests alone.

## Publish only after approval

Create the release tag and publish approved artifacts only after acceptance. Verify anonymous npm installs and container pulls, intended architectures, revision labels and matching source. Finish by updating the documentation's published-version baseline to the artifacts actually available.
