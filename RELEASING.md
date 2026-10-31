# Release preparation

A version bump is a candidate, not publication. Keep source, SDK packages, image roles and installation files aligned before creating a tag or publishing anything.

## Package ownership and order

| Package                | Source                          | Candidate version |
| ---------------------- | ------------------------------- | ----------------- |
| `@relayrtc/types`      | `packages/types`                | 0.1.4             |
| `@relayrtc/validation` | `packages/validation`           | 0.1.4             |
| `@relayrtc/protocol`   | `packages/protocol`             | 0.1.4             |
| `@relayrtc/client`     | `packages/client`               | 0.1.4             |
| `@relayrtc/react`      | Separate `react-sdk` repository | 0.1.4             |
| `@relayrtc/node`       | Separate `node-sdk` repository  | 0.1.4             |

Publish types, validation, protocol and client in dependency order, then React. Node has no runtime package dependencies but still requires acceptance against the target API. React's browser-client peer is `^0.1.4`; React 18.3.1 and 19 remain supported. The wire protocol and REST contract remain version 1 independently of npm versions.

## React dependency lock

The React manifest requires `@relayrtc/client` at `^0.1.4`. Its existing lockfile still records the previously published browser client. Publish the four core packages first, then run `pnpm install --no-frozen-lockfile --ignore-scripts` in `react-sdk` and commit the resulting lockfile before publishing React. Do not substitute made-up registry checksums or commit sibling development links. Local-source declaration checks do not replace this release dependency step.

## Prepare artifacts

Install locked dependencies, then build types, validation, protocol and client in order. Build Node/React from their own repositories using compatible dependencies. Each public package has a prepack build hook; do not publish stale build output.

Pack all six packages locally. Inspect their manifests, runtime/declaration entry points, license, README and changelog. Workspace dependencies must become published versions in the tarball; no `link:` or sibling `file:` dependency may remain. Keep the validated tarballs and their hashes outside source control and publish those exact files after approval.

Use isolated consumers with only the packed packages and public dependencies. Typecheck against React 18 and 19, bundle browser entry points without Node built-ins, import the Node package, and verify provider server rendering. Do not use source aliases or sibling SDK links as evidence of package acceptance.

Regenerate the React lockfile from the actual published core packages. Verify the resolved versions and registry integrity before building and publishing React. Do not infer registry availability from a source version bump.

## Images and installation

The image workflow publishes eleven Docker Hub image families under `relayrtc`: API, signaling, media, console, migrator, coturn, Prometheus, Grafana, streaming, streaming-storage and streaming-storage-init. The four streaming worker roles share the streaming image with role-specific commands. Media builds use native AMD64 and ARM64 runners, then combine their architecture-specific, commit-scoped tags into `relayrtc/media:<version>`. Its build stage installs Python/pip and a C++ toolchain and compiles the pinned mediasoup worker against the runtime's Debian base. `MEDIASOUP_BUILD_CORES` defaults to 2 to bound compilation resources. Other service images keep their existing multi-platform build path. For a full release, after those builds and the media manifest succeed, the installer publishes `relayrtc/relayrtc:<version>` and `latest`. New images are not published to GitHub Packages by this workflow.

For a manual run, select the source branch, version and image in **Actions → Publish container images → Run workflow**. Choose `all` for the complete release or a single image to rebuild only that image. Choose `setup` for installer fixes after the matching service image version has already been published. A setup-only run publishes `relayrtc/relayrtc:<version>` and `latest` without rebuilding the services. Selecting `media` builds both native architectures and combines their manifest. Other individual selections publish only the selected service and do not republish the installer. Tag pushes always publish the complete release. Start a new manual run after merging a fix so it uses the updated source.

Configure GitHub Actions secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. The Docker Hub account/token must have push access to the `relayrtc` namespace and the intended public repositories. Configure those repositories and their visibility before publication. Workflow edits do not create accounts, credentials or public visibility automatically.

The standard installation includes calls and streaming. Canonical source composition remains `docker-compose.yml` plus `docker-compose.streaming.yml`. The manual release overrides also use versioned Docker Hub images. The wizard resolves those definitions into one portable generated Compose file and rewrites RelayRTC images to matching versioned Docker Hub repositories.

## Browser installer

`infrastructure/docker/setup.Dockerfile` bundles Node, Docker CLI, Compose, the existing configuration generator and static wizard assets. The UI serves the console's existing stylesheet, fonts and logo. `install` is the default entrypoint and also works with `--entrypoint install`.

The wizard runs on port 9095, writes `./relayrtc` below the mounted parent directory and starts no application containers. Its generated `.env` and `docker-compose.yml` are private. Gateway and monitoring mount scoped runtime folders. Host Compose reads the generated environment so ordinary settings can be edited before recreating services.

Build locally without publishing or installing:

```sh
docker build --platform linux/amd64,linux/arm64 --file infrastructure/docker/setup.Dockerfile --build-arg RELAYRTC_VERSION=0.1.4 --tag relayrtc/relayrtc:local .
```

A local installer image still needs matching application images in Docker Hub before the generated stack can start. Keep documentation and bundled `release.json` aligned with the actual release. The release candidate is 0.1.4. This change does not remove or recreate an existing tag and does not publish artifacts.

`latest` is an installer convenience alias. Generated application images use the installer's bundled release number. Publish the alias only for the intended current release. Existing deployments retain their pinned image versions. The wizard supports initial installation and same-version configuration, not automatic cross-version migration.

Local and public installations can skip email and OAuth. No administrator bootstrap account or password is created. Existing named-volume deployments and source installations need a controlled migration preserving their original keys and data. Do not point new generated credentials at existing volumes.

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
