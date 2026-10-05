# WorldSmith gatekeeper. Build from the repo root:  docker build -f apps/gatekeeper/Dockerfile .
FROM node:24-alpine
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mcproto/package.json packages/mcproto/
COPY apps/gatekeeper/package.json apps/gatekeeper/
RUN pnpm install --frozen-lockfile --prod --filter "@worldsmith/gatekeeper..."

COPY packages/mcproto/src packages/mcproto/src
COPY apps/gatekeeper/src apps/gatekeeper/src

USER node
ENV NODE_ENV=production
CMD ["node", "apps/gatekeeper/src/main.ts"]
