# syntax=docker/dockerfile:1.7
# DukaanAI API (NestJS + Prisma on MySQL 8, BullMQ on Redis). Roadmap 7.3.
#
# Build from the repository root (the npm workspace is the unit of install):
#   docker build -f apps/api/Dockerfile -t dukaanai-api .
#
# The same image runs the release step and the server:
#   migrate: docker run --rm -e DATABASE_URL=... dukaanai-api /app/node_modules/.bin/prisma migrate deploy
#   serve:   docker run -e NODE_ENV=production -e DATABASE_URL=... -e REDIS_URL=... \
#              -e JWT_SECRET=... -e FRONTEND_URL=... -p 3002:3002 dukaanai-api
#
# Node is pinned to one exact version (NODE_VERSION, same major as .nvmrc);
# bump it here and in .nvmrc together. Debian slim rather than Alpine: the
# Prisma engines, sharp and bcrypt ship glibc builds, and Prisma needs
# OpenSSL at runtime.
#
# Supply chain (roadmap 9.14, the release Trivy gate): the base stage takes
# Debian's security updates at build time (`apt-get upgrade`), because the
# Node base image lags them, and the runtime stage deletes the npm, npx and
# corepack that the Node image bundles: they are build tools whose own
# dependencies (tar, brace-expansion, sigstore, ...) carry fixable advisories,
# and nothing in the running image calls them. The Prisma CLI, the one tool
# the image runs besides the server (the release step), is the production
# dependency itself: /app/node_modules/.bin/prisma, also on PATH.
ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
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
# The release the image is (roadmap 9.21): the version tag or sha-<commit>,
# passed by .github/workflows/release.yml; GET /api/health and the build_info
# metric report it, and the OCI labels let `docker inspect` say what it is.
ARG APP_RELEASE=
ARG APP_REVISION=
LABEL org.opencontainers.image.title="dukaanai-api" \
      org.opencontainers.image.source="https://github.com/shoryabansalgithub/DukanAi-real" \
      org.opencontainers.image.version="${APP_RELEASE}" \
      org.opencontainers.image.revision="${APP_REVISION}"
ENV NODE_ENV=production PORT=3002 APP_RELEASE=${APP_RELEASE} PATH=/app/node_modules/.bin:$PATH
# No package manager at run time (see the header). The storage root and the
# multipart temp directory are volumes in compose; both default paths exist
# and belong to the runtime user.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && mkdir -p /var/lib/dukaanai/storage /app/apps/api/uploads/tmp \
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
