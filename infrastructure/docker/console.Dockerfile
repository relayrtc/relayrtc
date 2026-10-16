FROM node:24-alpine AS dependencies

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/console/package.json apps/console/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/validation/package.json packages/validation/package.json
COPY services/api/package.json services/api/package.json
COPY services/signaling/package.json services/signaling/package.json
COPY tooling/workspace-smoke/package.json tooling/workspace-smoke/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS source

COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @relayrtc/console...

FROM source AS builder

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=@relayrtc/console

FROM node:24-alpine AS runner

WORKDIR /workspace
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3002

COPY --from=builder --chown=node:node /workspace/apps/console/.next/standalone ./
COPY --from=builder --chown=node:node /workspace/apps/console/.next/static ./apps/console/.next/static
COPY --from=builder --chown=node:node /workspace/apps/console/public ./apps/console/public

USER node
EXPOSE 3002
CMD ["node", "apps/console/server.js"]
