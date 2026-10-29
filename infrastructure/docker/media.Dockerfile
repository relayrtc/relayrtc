FROM node:24-bookworm-slim AS dependencies

WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHON=python3
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/media/package.json services/media/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/validation/package.json packages/validation/package.json
ARG MEDIASOUP_BUILD_CORES=2
RUN MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true python3 -c "import os, subprocess; cores = max(1, int(os.environ['MEDIASOUP_BUILD_CORES'])); os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:cores]); subprocess.run(['pnpm', 'install', '--frozen-lockfile', '--filter', '@relayrtc/media...'], check=True)"

FROM dependencies AS builder

COPY tsconfig.base.json eslint.config.mjs ./
COPY services/media services/media
COPY packages/database packages/database
COPY packages/types packages/types
COPY packages/protocol packages/protocol
COPY packages/validation packages/validation
RUN pnpm --filter @relayrtc/types build && pnpm --filter @relayrtc/validation build && pnpm --filter @relayrtc/protocol build && pnpm --filter @relayrtc/database build && pnpm --filter @relayrtc/media build

FROM node:24-bookworm-slim AS runner

WORKDIR /workspace
ENV MEDIA_HOST=0.0.0.0
ENV MEDIA_PORT=8082
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /workspace/node_modules ./node_modules
COPY --from=builder --chown=node:node /workspace/services/media/package.json ./services/media/package.json
COPY --from=builder --chown=node:node /workspace/services/media/dist ./services/media/dist
COPY --from=builder --chown=node:node /workspace/services/media/node_modules ./services/media/node_modules
COPY --from=builder --chown=node:node /workspace/packages/database/package.json ./packages/database/package.json
COPY --from=builder --chown=node:node /workspace/packages/database/dist ./packages/database/dist
COPY --from=builder --chown=node:node /workspace/packages/database/node_modules ./packages/database/node_modules
COPY --from=builder --chown=node:node /workspace/packages/types/package.json ./packages/types/package.json
COPY --from=builder --chown=node:node /workspace/packages/types/dist ./packages/types/dist
COPY --from=builder --chown=node:node /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder --chown=node:node /workspace/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder --chown=node:node /workspace/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=builder --chown=node:node /workspace/packages/validation/package.json ./packages/validation/package.json
COPY --from=builder --chown=node:node /workspace/packages/validation/dist ./packages/validation/dist
COPY --from=builder --chown=node:node /workspace/packages/validation/node_modules ./packages/validation/node_modules

USER node
EXPOSE 8082
EXPOSE 40000/tcp
EXPOSE 40000/udp
CMD ["node", "--enable-source-maps", "services/media/dist/server.js"]
