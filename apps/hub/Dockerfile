# WorldSmith hub. Build from the repo root:  docker build -f apps/hub/Dockerfile .
FROM node:24-alpine

WORKDIR /app
RUN corepack enable

# Install only the hub's production dependency closure (hub + workspace packages it uses).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mcproto/package.json packages/mcproto/
COPY packages/mcdata/package.json packages/mcdata/
COPY packages/core/package.json packages/core/
COPY packages/mcworld/package.json packages/mcworld/
COPY apps/hub/package.json apps/hub/
RUN pnpm install --frozen-lockfile --prod --filter "@worldsmith/hub..."

COPY packages/mcproto/src packages/mcproto/src
COPY packages/mcdata/src packages/mcdata/src
COPY packages/mcdata/versions packages/mcdata/versions
COPY packages/core/src packages/core/src
COPY packages/mcworld/src packages/mcworld/src
COPY apps/hub/src apps/hub/src
COPY apps/hub/portal apps/hub/portal
COPY recipes recipes

# Named volumes inherit this ownership on first use.
RUN mkdir -p /data /ipc && chown node:node /data /ipc
USER node
ENV NODE_ENV=production DATA_DIR=/data
CMD ["node", "apps/hub/src/main.ts"]
