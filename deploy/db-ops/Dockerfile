# The compose `db-ops` and `binlog-archiver` services (roadmap 7.7, 9.2, 9.3,
# 9.4): the MySQL 8 clients (mysql, mysqldump, mysqlbinlog; the Debian variant
# has all three, the Oracle Linux image lacks mysqlbinlog), GNU tar and
# coreutils for the documents archive, and rclone for the encrypted off-site
# copy. Built from the repository root: docker build -f deploy/db-ops/Dockerfile .
#
# MySQL 8.0 reached end of life in April 2026 and the official images stopped
# at 8.0.46 (the docker-library 8.0 Debian variant is gone); MySQL 8.4 LTS has
# no Debian image, only Oracle Linux, whose minimal server package is the one
# that lacked mysqlbinlog for 8.0. The move to 8.4 clients is planned in
# docs/DEPLOYMENT.md ("MySQL versions"). Against an 8.4 server these 8.0
# clients still dump and restore, but mysqldump 8.0 reads the binary-log
# position with SHOW MASTER STATUS, which 8.4 removed: verify a backup's
# position line there, or set BACKUP_COORDINATES=skip. Pinned to the patch
# release; Dependabot proposes updates. The compose files run the container
# as uid 1000 (audit 2026-10-11, R25), Kubernetes too.
FROM mysql:8.0.46-debian
# The release the image belongs to (roadmap 9.21), passed by the release workflow.
ARG APP_RELEASE=
ARG APP_REVISION=
LABEL org.opencontainers.image.title="dukaanai-db-ops" \
      org.opencontainers.image.source="https://github.com/shoryabansalgithub/DukanAi-real" \
      org.opencontainers.image.version="${APP_RELEASE}" \
      org.opencontainers.image.revision="${APP_REVISION}"
# Debian's security updates are taken at build time (roadmap 9.14, the
# release Trivy gate); the MySQL packages stay at the base image's release so
# the clients match the server line the image was chosen for. gosu exists
# only for the MySQL server entrypoint, which this image replaces, and is an
# old Go build: removed.
RUN apt-get update \
  && apt-mark hold $(dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 'mysql-*' | awk '$1 == "ii" { print $2 }') \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -f /usr/local/bin/gosu \
  && rm -rf /var/lib/apt/lists/*
# The jobs run as uid 1000 (compose `user:`, Kubernetes runAsUser): a fresh
# named volume mounted at /backups or /restore takes this ownership from the
# image (an older root-owned backup volume is handed over by the compose
# service backup-volume-init).
RUN mkdir -p /backups /restore && chown 1000:1000 /backups /restore
# The repository's scripts are baked in so the image runs on its own (the
# Kubernetes backup sidecar, deploy/k8s); compose mounts the checkout's
# scripts/ over /scripts for development.
COPY scripts /scripts
ENTRYPOINT ["bash", "/scripts/db/db-ops.sh"]
