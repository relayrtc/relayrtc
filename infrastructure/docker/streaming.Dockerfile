FROM node:24-bookworm-slim AS builder
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/types/package.json packages/types/package.json
COPY packages/validation/package.json packages/validation/package.json
COPY services/streaming/package.json services/streaming/package.json
RUN pnpm install --frozen-lockfile --filter @relayrtc/streaming...
COPY tsconfig.base.json ./
COPY packages/types packages/types
COPY packages/validation packages/validation
COPY services/streaming services/streaming
RUN pnpm --filter @relayrtc/types build && pnpm --filter @relayrtc/validation build && pnpm --filter @relayrtc/streaming build

# Debian trixie supplies FFmpeg 7.1 with the selected codecs. FFmpeg remains replaceable.
FROM node:24-trixie-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /workspace/node_modules ./node_modules
COPY --from=builder --chown=node:node /workspace/packages/types ./packages/types
COPY --from=builder --chown=node:node /workspace/packages/validation ./packages/validation
COPY --from=builder --chown=node:node /workspace/services/streaming ./services/streaming
USER node
EXPOSE 8090
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8090/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "services/streaming/dist/server.js"]
