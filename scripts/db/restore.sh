#!/usr/bin/env bash
# Restore a backup made by backup.sh into a MySQL 8 database (roadmap 7.7).
#
#   scripts/db/restore.sh BACKUP.sql.gz [--database NAME] [--create] [--yes]
#
#   --database NAME  restore into NAME instead of the database in DATABASE_URL
#   --create         CREATE DATABASE IF NOT EXISTS first (needs that privilege)
#   --yes            actually restore; without it the plan is printed and nothing changes
#
# The dump drops and re-creates every table it contains, so the target is
# replaced, not merged: stop the API (or restore into a fresh database and
# switch DATABASE_URL) before restoring over a live one. The SHA-256 sidecar
# is verified when present. Afterwards run, from apps/api with DATABASE_URL
# pointing at the restored database:
#   npx prisma migrate status
#   npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -ge 1 ] || { sed -n '2,20p' "$0"; exit 2; }
BACKUP="$1"; shift
TARGET_DB=""
CREATE=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --database) TARGET_DB="$2"; shift 2 ;;
    --create) CREATE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -f "$BACKUP" ] || die "backup not found: $BACKUP"

load_connection
require_clients
assert_server
TARGET_DB="${TARGET_DB:-$DB_NAME}"
assert_identifier "$TARGET_DB"

if [ -f "$BACKUP.sha256" ]; then
  step "Verifying $(basename "$BACKUP").sha256"
  ( cd "$(dirname "$BACKUP")" && sha256sum -c "$(basename "$BACKUP").sha256" ) || die "checksum mismatch: the backup is damaged or was altered"
else
  printf 'WARNING: no %s.sha256 next to the backup; integrity not verified\n' "$(basename "$BACKUP")" >&2
fi
gzip -t "$BACKUP" || die "not a valid gzip file: $BACKUP"

tables="$(gzip -dc "$BACKUP" | grep -c '^CREATE TABLE ' || true)"
step "Plan: restore $(basename "$BACKUP") ($(du -h "$BACKUP" | cut -f1), $tables tables) into $TARGET_DB on $DB_HOST:$DB_PORT as $DB_USER"
if [ "$YES" != 1 ]; then
  printf 'Dry run: pass --yes to restore (every table in the dump is dropped and re-created in %s).\n' "$TARGET_DB"
  exit 0
fi

if [ "$CREATE" = 1 ]; then
  step "CREATE DATABASE IF NOT EXISTS $TARGET_DB"
  "$MYSQL_BIN" $(conn_args) -e "CREATE DATABASE IF NOT EXISTS \`$TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
fi
sql "$TARGET_DB" "SELECT 1" >/dev/null 2>&1 || die "database $TARGET_DB does not exist (pass --create) or is not accessible"

step "Restoring into $TARGET_DB"
started="$(date +%s)"
gzip -dc "$BACKUP" | "$MYSQL_BIN" $(conn_args) --database="$TARGET_DB"
elapsed=$(( $(date +%s) - started ))

restored="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$TARGET_DB'")"
migrations="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || echo 'n/a')"
triggers="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$TARGET_DB'")"
step "Restored $restored tables, $triggers triggers, $migrations applied migrations into $TARGET_DB in ${elapsed}s"
printf 'Next: from apps/api, with DATABASE_URL on %s, run `npx prisma migrate status` and the migrate diff (see the header of this script).\n' "$TARGET_DB"
