# The restore drills of the Azure target (deploy/azure/stack.sh drill):
# scripts/db/restore-drill.sh, scripts/storage/restore-drill.sh and
# scripts/backup/offsite-drill.sh need the MySQL 8.4 clients, GNU tar and
# rclone (the db-ops image) plus Node and the API's dependencies (`npx prisma
# migrate status / diff`, `npm run reconcile`). The VM has neither Node nor a
# MySQL client of its own, so the drills run here.
#
#   docker build -f deploy/azure/drill.Dockerfile --build-arg DB_OPS_IMAGE=<registry>/dukaanai-db-ops:<tag> .
#
# Built from the repository root on the host (compose service `drill`,
# profile drill); a tool image, never pushed and never part of a release.
ARG DB_OPS_IMAGE=dukaanai-db-ops
# The same Node as the API image (apps/api/Dockerfile, .nvmrc).
ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM ${DB_OPS_IMAGE}
# Node's official build needs only glibc and libstdc++ from the system, both
# already there (the MySQL client links them).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
# diffutils: the documents drill compares the two manifests with cmp / diff.
RUN microdnf -y --setopt=install_weak_deps=0 --disablerepo=mysql84-community install diffutils \
  && microdnf clean all \
  && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && node --version && npm --version && cmp --version | head -n 1
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /repo
# The API workspace with its dev dependencies: the reconcile script runs on ts-node.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/invoice-math/package.json packages/invoice-math/
RUN npm ci --ignore-scripts -w api -w @dukaanai/invoice-math
COPY packages/invoice-math packages/invoice-math
COPY apps/api apps/api
COPY scripts scripts
# The Prisma client and its engines are fetched now: the drills run as uid
# 1000 and cannot write into node_modules.
RUN npm run build -w @dukaanai/invoice-math \
  && cd apps/api \
  && npx prisma generate \
  && npx prisma version
ENTRYPOINT []
CMD ["bash"]
