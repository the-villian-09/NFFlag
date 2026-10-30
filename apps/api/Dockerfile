# NFFL API image for Cloud Run. Build from the repo root:
#   docker build -f apps/api/Dockerfile -t nffl-api .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @nffl/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @nffl/shared build && pnpm --filter @nffl/api build
RUN pnpm deploy --filter @nffl/api --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
USER node
EXPOSE 8080
# Same image runs three ways on Cloud Run:
#   service:          node dist/server.js            (default)
#   migrate job:      node dist/db/migrate.js && node dist/db/seed.js
#   outbox worker job: node dist/worker.js
CMD ["node", "dist/server.js"]
