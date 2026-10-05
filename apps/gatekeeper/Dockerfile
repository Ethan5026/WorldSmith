# WorldSmith gatekeeper. Build from the repo root:  docker build -f apps/gatekeeper/Dockerfile .
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY packages/mcproto/package.json packages/mcproto/
COPY packages/mcproto/src packages/mcproto/src
COPY apps/gatekeeper/package.json apps/gatekeeper/
COPY apps/gatekeeper/src apps/gatekeeper/src
USER node
ENV NODE_ENV=production
CMD ["node", "apps/gatekeeper/src/main.ts"]
