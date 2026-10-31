# RelayRTC browser installer

The Docker Hub image `relayrtc/relayrtc` runs the `install` entrypoint and opens a private setup wizard on port 9095. It generates a host folder containing `.env`, `docker-compose.yml`, runtime configuration and nonsecret wizard metadata. It starts no application containers. Operators run `cd relayrtc` and `docker compose up -d --remove-orphans` afterward.

## Build

From the repository root:

```sh
docker build --platform linux/amd64,linux/arm64 --file infrastructure/docker/setup.Dockerfile --build-arg RELAYRTC_VERSION=0.1.4 --tag relayrtc/relayrtc:local .
```

A successful installer build does not establish a published Docker Hub release or working deployment. Matching service images must exist in Docker Hub before the stack starts. Local builds publish nothing.

## Run

From your installation parent directory on macOS/Linux:

```sh
docker run -it --rm -p 127.0.0.1:9095:9095 -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd):/setup/state" relayrtc/relayrtc:latest
```

The mounted directory is the parent of the generated `relayrtc` folder. Keep the default Docker hostname for mount inspection. Use the Linux Docker engine. The image bundles Docker CLI and Compose, while the host needs Compose to start the generated stack.

Open the full private URL printed in the terminal. It exchanges a random URL-fragment token for an HttpOnly SameSite cookie. API writes check the browser origin. The local listener rejects unrelated Host values and expires inactive sessions. Use SSH forwarding for a remote server.

## Modules

| File | Responsibility |
| --- | --- |
| `entrypoint` | Executable `install` launcher |
| `install.mjs` | HTTP server, private session, static assets, bounded requests and shutdown |
| `wizard-config.mjs` | Validation, generation, preservation, backups and host ownership |
| `ui/` | Four-step browser flow using console styles, fonts and logo |
| `manifest.mjs` | Canonical composition, folder/legacy-volume layouts and registry selection |
| `state.mjs` | Private writes, mount inspection and installation locking |
| `docker.mjs` | Docker process execution, bounded captures and cancellation |
| `release.json` | Bundled release identity stamped during image build |
| `cli.mjs` | Previous named-volume CLI retained for existing advanced installations |

The wizard reuses the existing environment generator and streaming preparation. PostgreSQL is fixed. Rooms, streaming, mediasoup, coturn, storage and monitoring are included. Resend/GitHub/Google can be configured, retained or skipped. Email verification and email-dependent operations are disabled when email is skipped, including public hosting.

Folder manifests preserve canonical Compose expressions so host `.env` edits apply on recreation. Application images pin the bundled version. Gateway/monitoring use relative runtime binds and receive no full secret-bearing installation root. Legacy volume manifests retain their existing dollar escaping and mount behavior.

Same-version reruns preserve infrastructure keys and snapshot configuration. The wizard refuses unrelated project data. Foreign configurations and cross-version migrations need a controlled procedure. A domain setting does not provision DNS, HTTPS, firewall rules or multi-host networking.

Generated secret files use mode 0600 and the installation directory uses mode 0700. On Linux, entries inherit the mounted parent's owner without changing its permissions. Runtime subdirectories remain readable by their scoped service containers.

## Release

`publish-images.yml` uses Docker Hub secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. The account needs push access to public repositories under `relayrtc`. Services publish first, followed by `relayrtc/relayrtc:<version>` and `relayrtc/relayrtc:latest`. The workflow no longer writes GitHub Packages.

No administrator account is created by setup. Users create their normal account in the running console. Automatic upgrades, certificate provisioning and adoption of previous named-volume deployments are outside the wizard's supported operations.

## Verification boundary

Use syntax, lint, formatting, compilation, image builds and static Compose inspection. Those checks do not establish a working installation, migration, browser interaction, media path or upgrade recovery. No tests or live application deployment are run under the current no-tests rule.
