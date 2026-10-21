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

FROM oraclelinux:9-slim@sha256:2feab5eb9e442ab342de183d12aa72a619e8080bee27ba1957a2005cf6a3879b
ARG MYSQL_VERSION
ARG TARGETARCH
# The release the image belongs to (roadmap 9.21), passed by the release workflow.
ARG APP_RELEASE=
ARG APP_REVISION=
LABEL org.opencontainers.image.title="dukaanai-db-ops" \
      org.opencontainers.image.source="https://github.com/shoryabansalgithub/DukanAi-real" \
      org.opencontainers.image.version="${APP_RELEASE}" \
      org.opencontainers.image.revision="${APP_REVISION}"
# rclone from its own release, pinned by checksum per architecture: Oracle
# Linux's repositories do not carry it.
ARG RCLONE_VERSION=1.75.2
ARG RCLONE_SHA256_AMD64=d5174054cf94075c32faf25961687622b8d366b788972ea9fbcedba59013e320
ARG RCLONE_SHA256_ARM64=a75caa786a24dc534104f955f592b6aae21c15d9b9abf9f1a6a6b2cbf707a98a
COPY --from=mysql-key /etc/pki/rpm-gpg/RPM-GPG-KEY-mysql /etc/pki/rpm-gpg/RPM-GPG-KEY-mysql
# Security updates are taken at build time (roadmap 9.14, the release Trivy
# gate); the MySQL repository is left out of the upgrade so the clients stay
# at MYSQL_VERSION.
RUN printf '[mysql84-community]\nname=MySQL 8.4 Community\nbaseurl=https://repo.mysql.com/yum/mysql-8.4-community/el/9/$basearch/\nenabled=1\ngpgcheck=1\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-mysql\nmodule_hotfixes=true\n' \
      > /etc/yum.repos.d/mysql84-community.repo \
  && microdnf -y --setopt=install_weak_deps=0 --disablerepo=mysql84-community upgrade \
  && microdnf -y --setopt=install_weak_deps=0 install \
       "mysql-community-client-${MYSQL_VERSION}" tar gzip findutils ca-certificates \
  && arch="${TARGETARCH:-$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')}" \
  && case "$arch" in \
       amd64) sum="$RCLONE_SHA256_AMD64" ;; \
       arm64) sum="$RCLONE_SHA256_ARM64" ;; \
       *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSLo /tmp/rclone.rpm "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${arch}.rpm" \
  && echo "$sum  /tmp/rclone.rpm" | sha256sum -c - \
  && rpm -i /tmp/rclone.rpm \
  && rm -f /tmp/rclone.rpm \
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
