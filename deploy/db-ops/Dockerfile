# The compose `db-ops`, `binlog-archiver` and `backup-agent` services (roadmap
# 7.7, 9.2, 9.3, 9.4): the MySQL 8.4 clients (mysql, mysqldump, mysqlbinlog),
# GNU tar and coreutils for the documents archive, and rclone for the
# encrypted off-site copy. Built from the repository root for linux/amd64 and
# linux/arm64 (the Azure VM, deploy/azure): docker build -f deploy/db-ops/Dockerfile .
#
# Why Oracle Linux 9 and not Debian: MySQL 8.0 reached end of life in April
# 2026, MySQL 8.4 LTS has no official Debian image, and the MySQL APT
# repository publishes amd64 only. The official mysql:8.4 image is Oracle
# Linux 9 but carries only the minimal server package, which has no
# mysqlbinlog. The MySQL YUM repository publishes the full 8.4 client for
# both architectures, signed with the key the official image ships, so this
# image takes that key from it and installs the client package at the same
# patch release as the server (docker-compose.yml).
# mysqldump 8.4 records the binary-log position with SHOW BINARY LOG STATUS,
# which 8.0's SHOW MASTER STATUS became. The compose files run the container
# as uid 1000 (audit 2026-10-11, R25), Kubernetes too.
ARG MYSQL_VERSION=8.4.11
FROM mysql:${MYSQL_VERSION} AS mysql-key

# rclone (the encrypted off-site copy, roadmap 9.4) is built from source on a
# patched Go: its release binaries lag Go's security releases (v1.76.0 ships
# go1.27.3, and the release Trivy gate fails on its fixable stdlib CVEs), and
# Oracle Linux's repositories do not carry it. `go install module@version`
# verifies the module against the Go checksum database (sum.golang.org), so
# the source is pinned as firmly as a release checksum; GOTOOLCHAIN=local
# keeps the build on this image's Go. The ldflags are rclone's own release
# flags. Bump RCLONE_RELEASE with rclone's releases, the Go image with Go's
# security releases (tag and digest together).
FROM golang:1.27.4-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d AS rclone
ARG RCLONE_RELEASE=v1.76.0
RUN CGO_ENABLED=0 GOTOOLCHAIN=local GOBIN=/out \
      go install -trimpath -ldflags "-s -w -X github.com/rclone/rclone/fs.Version=${RCLONE_RELEASE}" \
      "github.com/rclone/rclone@${RCLONE_RELEASE}" \
  && /out/rclone version | head -n 1

FROM oraclelinux:9-slim@sha256:2feab5eb9e442ab342de183d12aa72a619e8080bee27ba1957a2005cf6a3879b
ARG MYSQL_VERSION
# The release the image belongs to (roadmap 9.21), passed by the release workflow.
ARG APP_RELEASE=
ARG APP_REVISION=
LABEL org.opencontainers.image.title="dukaanai-db-ops" \
      org.opencontainers.image.source="https://github.com/shoryabansalgithub/DukanAi-real" \
      org.opencontainers.image.version="${APP_RELEASE}" \
      org.opencontainers.image.revision="${APP_REVISION}"
COPY --from=rclone /out/rclone /usr/bin/rclone
COPY --from=mysql-key /etc/pki/rpm-gpg/RPM-GPG-KEY-mysql /etc/pki/rpm-gpg/RPM-GPG-KEY-mysql
# Security updates are taken at build time (roadmap 9.14, the release Trivy
# gate); the MySQL repository is left out of the upgrade so the clients stay
# at MYSQL_VERSION.
RUN printf '[mysql84-community]\nname=MySQL 8.4 Community\nbaseurl=https://repo.mysql.com/yum/mysql-8.4-community/el/9/$basearch/\nenabled=1\ngpgcheck=1\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-mysql\nmodule_hotfixes=true\n' \
      > /etc/yum.repos.d/mysql84-community.repo \
  && microdnf -y --setopt=install_weak_deps=0 --disablerepo=mysql84-community upgrade \
  && microdnf -y --setopt=install_weak_deps=0 install \
       "mysql-community-client-${MYSQL_VERSION}" tar gzip findutils ca-certificates \
  && microdnf clean all \
  && mysqlbinlog --version && rclone version | head -n 1
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
