#!/usr/bin/env bash
# Entrypoint of the compose `db-ops` service (roadmap 7.7): a MySQL 8 client
# container with the backup scripts mounted at /scripts and the backups
# volume at /backups.
#
#   docker compose --profile ops run --rm db-ops backup [--label TEXT]
#   docker compose --profile ops run --rm db-ops restore /backups/<file>.sql.gz --yes
#   docker compose --profile ops run --rm db-ops list
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  backup) exec bash /scripts/backup.sh "$@" ;;
  restore) exec bash /scripts/restore.sh "$@" ;;
  list) ls -lh "${BACKUP_DIR:-/backups}"/*.sql.gz 2>/dev/null || echo "no backups in ${BACKUP_DIR:-/backups}" ;;
  *) echo "usage: db-ops backup [--label TEXT] | restore FILE --yes | list" >&2; exit 2 ;;
esac
