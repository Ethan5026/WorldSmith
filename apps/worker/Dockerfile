# WorldSmith worker. Build from the repo root:  docker build -f apps/worker/Dockerfile .
# Runs as root: it holds the Docker socket, which is root-equivalent anyway. Keep its API private.
FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mcproto/package.json packages/mcproto/
COPY packages/core/package.json packages/core/
COPY packages/mcdata/package.json packages/mcdata/
COPY packages/mcworld/package.json packages/mcworld/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --prod --filter "@worldsmith/worker..."

COPY packages/mcproto/src packages/mcproto/src
COPY packages/mcdata/src packages/mcdata/src
COPY packages/mcdata/versions packages/mcdata/versions
COPY packages/core/src packages/core/src
COPY packages/mcworld/src packages/mcworld/src
COPY apps/worker/src apps/worker/src

ENV NODE_ENV=production CACHE_DIR=/cache
CMD ["node", "apps/worker/src/main.ts"]
