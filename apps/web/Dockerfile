# syntax=docker/dockerfile:1.7
# DukaanAI web (Next.js 16, standalone output). Roadmap 7.3.
#
# Build from the repository root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api -t dukaanai-web .
#
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so
# the API URL the browser calls is a build argument; everything server-side
# (NEXTAUTH_SECRET, NEXTAUTH_URL, API_INTERNAL_URL, Google OAuth) is runtime
# environment. NEXT_PUBLIC_AUTH_DISABLED is never set here: next.config.js
# refuses a production build with it. Node pinned like apps/api/Dockerfile,
# and patched like it (roadmap 9.14): Debian security updates at build time,
# no npm / npx / corepack in the runtime stage (the standalone server needs
# only node).
ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/invoice-math/package.json packages/invoice-math/
RUN npm ci --ignore-scripts

FROM deps AS build
# The build-time value is only the fallback: the running container sets
# API_PUBLIC_URL and one image serves staging and production (roadmap 9.9).
ARG NEXT_PUBLIC_API_URL=http://localhost:3002/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_STANDALONE=true NODE_ENV=production
COPY packages/invoice-math packages/invoice-math
COPY apps/web apps/web
RUN npm run build -w @dukaanai/invoice-math \
  && npm run build -w dukaanai-web

# ---- runtime: the traced standalone server plus static assets, non-root ----
FROM base AS runtime
# The release the image is (roadmap 9.21), reported by GET /api/health.
ARG APP_RELEASE=
ARG APP_REVISION=
LABEL org.opencontainers.image.title="dukaanai-web" \
      org.opencontainers.image.source="https://github.com/shoryabansalgithub/DukanAi-real" \
      org.opencontainers.image.version="${APP_RELEASE}" \
      org.opencontainers.image.revision="${APP_REVISION}"
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 APP_RELEASE=${APP_RELEASE}
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/web/server.js"]
