FROM docker:29.9.2-cli AS docker-cli

FROM node:24-alpine AS runner
RUN apk add --no-cache ca-certificates
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /opt/relayrtc
ARG RELAYRTC_VERSION=0.1.3
ENV RELAYRTC_SETUP_VERSION=${RELAYRTC_VERSION}
COPY scripts/configure-env.mjs scripts/prepare-streaming.mjs ./scripts/
COPY infrastructure/setup ./infrastructure/setup/
COPY LICENSE /usr/share/licenses/relayrtc/LICENSE
COPY .env.example docker-compose.yml docker-compose.streaming.yml docker-compose.release.yml docker-compose.streaming.release.yml ./assets/
COPY infrastructure/configuration/streaming.env.example infrastructure/configuration/advanced.env.example ./assets/infrastructure/configuration/
COPY infrastructure/streaming/mediamtx.yml ./assets/infrastructure/streaming/
COPY infrastructure/prometheus/streaming.yml infrastructure/prometheus/streaming.rules.yml ./assets/infrastructure/prometheus/
RUN node -e "const fs=require('node:fs'); const version=process.env.RELAYRTC_SETUP_VERSION; if(!/^\\d+\\.\\d+\\.\\d+$/.test(version))throw new Error('Invalid release version'); fs.writeFileSync('infrastructure/setup/release.json',JSON.stringify({version}));" \
    && mkdir -p /setup/state && chmod 0700 /setup/state
ENTRYPOINT ["node", "/opt/relayrtc/infrastructure/setup/cli.mjs"]
