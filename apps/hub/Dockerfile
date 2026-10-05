# WorldSmith hub. Build from the repo root:  docker build -f apps/hub/Dockerfile .
FROM node:24-alpine

WORKDIR /app
RUN corepack enable

# Install only the hub's production dependency closure (hub + workspace packages it uses).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mcproto/package.json packages/mcproto/
COPY apps/hub/package.json apps/hub/
RUN pnpm install --frozen-lockfile --prod --filter "@worldsmith/hub..."

COPY packages/mcproto/src packages/mcproto/src
COPY apps/hub/src apps/hub/src
COPY apps/hub/portal apps/hub/portal

# Named volumes inherit this ownership on first use.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data
CMD ["node", "apps/hub/src/main.ts"]
