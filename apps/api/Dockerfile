# syntax=docker/dockerfile:1.7
# DukaanAI API (NestJS + Prisma on MySQL 8, BullMQ on Redis). Roadmap 7.3.
#
# Build from the repository root (the npm workspace is the unit of install):
#   docker build -f apps/api/Dockerfile -t dukaanai-api .
#
# The same image runs the release step and the server:
#   migrate: docker run --rm -e DATABASE_URL=... dukaanai-api npx prisma migrate deploy
#   serve:   docker run -e NODE_ENV=production -e DATABASE_URL=... -e REDIS_URL=... \
#              -e JWT_SECRET=... -e FRONTEND_URL=... -p 3002:3002 dukaanai-api
#
# Node is pinned to one exact version (NODE_VERSION, same major as .nvmrc);
# bump it here and in .nvmrc together. Debian slim rather than Alpine: the
# Prisma engines, sharp and bcrypt ship glibc builds, and Prisma needs
# OpenSSL at runtime.
ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- every workspace dependency, from the lockfile (postinstall skipped:
# `prisma generate` runs once the schema is present) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/invoice-math/package.json packages/invoice-math/
RUN npm ci --ignore-scripts

# ---- compile invoice-math (the API's workspace dependency) and the API ----
FROM deps AS build
COPY packages/invoice-math packages/invoice-math
COPY apps/api apps/api
RUN npm run build -w @dukaanai/invoice-math \
  && cd apps/api \
  && npx prisma generate \
  && npx @nestjs/cli build

# ---- production dependencies of the API only (the web's are not installed) ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/invoice-math/package.json packages/invoice-math/
RUN npm ci --omit=dev --ignore-scripts -w api -w @dukaanai/invoice-math \
  && mkdir -p apps/api/node_modules packages/invoice-math/node_modules
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
RUN cd apps/api && npx prisma generate

# ---- runtime: compiled output, production node_modules, Prisma schema and
# migrations (for `prisma migrate deploy`), no sources, non-root ----
FROM base AS runtime
ENV NODE_ENV=production PORT=3002
# The storage root and the multipart temp directory are volumes in compose;
# both default paths exist and belong to the runtime user.
RUN mkdir -p /var/lib/dukaanai/storage /app/apps/api/uploads/tmp \
  && chown -R node:node /var/lib/dukaanai /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/invoice-math/node_modules ./packages/invoice-math/node_modules
COPY --from=build --chown=node:node /app/packages/invoice-math/package.json ./packages/invoice-math/package.json
COPY --from=build --chown=node:node /app/packages/invoice-math/dist ./packages/invoice-math/dist
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node apps/api/package.json ./apps/api/package.json
COPY --chown=node:node apps/api/prisma ./apps/api/prisma
WORKDIR /app/apps/api
USER node
EXPOSE 3002
# Liveness only (the process answers HTTP). Readiness, which also proves the
# database and Redis, is GET /api/health/ready: point the orchestrator at it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3002) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# PID 1 is node itself (exec form), so SIGTERM reaches the shutdown hooks.
CMD ["node", "dist/main"]
