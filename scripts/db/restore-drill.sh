#!/usr/bin/env bash
# Restore drill (roadmap 7.7, phase 7 exit gate): proves that a backup made
# by backup.sh restores into a working database. From a repository checkout:
#
#   DATABASE_URL=mysql://user:pass@host:3306/dukaanai scripts/db/restore-drill.sh [--keep]
#
# Steps: back up the source database -> restore the file into a fresh scratch
# database on the same server (<db>_drill_<stamp>; the user needs CREATE
# DATABASE) -> `prisma migrate status` must be up to date and `prisma migrate
# diff` against schema.prisma must find no difference -> every table has the
# same row count on both sides -> the ledger triggers are present -> the
# scratch database is dropped (--keep leaves it). Run it against a quiet
# source (CI after the integration suites, a staging copy, or production
# during a maintenance window): with writes in flight the counts differ and
# the drill fails, which is the point. Needs node (prisma CLI from apps/api),
# mysql and mysqldump 8 on PATH (or MYSQL_BIN / MYSQLDUMP_BIN).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_connection
require_clients
assert_server
command -v node >/dev/null 2>&1 || die "node is required (prisma migrate status / diff)"

stamp="$(date -u +%Y%m%d%H%M%S)"
DRILL_DB="${DB_NAME}_drill_${stamp}"
assert_identifier "$DRILL_DB"
WORK="$(mktemp -d)"
started="$(date +%s)"
cleanup() {
  if [ "$KEEP" = 1 ]; then
    printf '\n--keep: scratch database %s left in place; backup in %s\n' "$DRILL_DB" "$WORK"
    return
  fi
  "$MYSQL_BIN" $(conn_args) -e "DROP DATABASE IF EXISTS \`$DRILL_DB\`" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "1/6 Backup of $DB_NAME ($DB_HOST:$DB_PORT, MySQL $(server_version))"
backup="$(bash "$REPO/scripts/db/backup.sh" --out "$WORK" --keep 0 --label drill | tail -n 1)"
[ -f "$backup" ] || die "backup.sh did not produce a file"

step "2/6 Restore into scratch database $DRILL_DB"
bash "$REPO/scripts/db/restore.sh" "$backup" --database "$DRILL_DB" --create --yes

# The scratch database's URL for the Prisma CLI, credentials percent-encoded.
enc() { node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$1"; }
DRILL_URL="mysql://$(enc "$DB_USER"):$(enc "$DB_PASS")@$DB_HOST:$DB_PORT/$DRILL_DB"

step "3/6 prisma migrate status on $DRILL_DB (every migration applied, nothing pending)"
status="$(cd "$REPO/apps/api" && DATABASE_URL="$DRILL_URL" npx prisma migrate status 2>&1)" || { printf '%s\n' "$status"; die "migrate status failed"; }
printf '%s\n' "$status" | tail -n 3
printf '%s\n' "$status" | grep -q "Database schema is up to date" || die "the restored database has pending or unknown migrations"

step "4/6 prisma migrate diff: restored schema == prisma/schema.prisma"
( cd "$REPO/apps/api" && DATABASE_URL="$DRILL_URL" npx prisma migrate diff --from-url "$DRILL_URL" --to-schema-datamodel prisma/schema.prisma --exit-code ) \
  || die "the restored schema differs from schema.prisma"

step "5/6 Row counts: every table of $DB_NAME has the same count in $DRILL_DB"
mismatches=0
tables=0
rows=0
while read -r table; do
  [ -n "$table" ] || continue
  src="$(sql "$DB_NAME" "SELECT COUNT(*) FROM \`$table\`")"
  dst="$(sql "$DRILL_DB" "SELECT COUNT(*) FROM \`$table\`" 2>/dev/null || echo missing)"
  tables=$((tables + 1))
  rows=$((rows + src))
  if [ "$src" != "$dst" ]; then
    printf '  MISMATCH %-40s source=%s restored=%s\n' "$table" "$src" "$dst"
    mismatches=$((mismatches + 1))
  fi
done < <(sql "$DB_NAME" "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$DB_NAME' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")
printf '  %s tables, %s rows compared\n' "$tables" "$rows"
[ "$mismatches" -eq 0 ] || die "$mismatches table(s) differ (was the source written to during the drill?)"
[ "$tables" -gt 0 ] || die "the source database has no tables"

step "6/6 Ledger immutability triggers restored"
src_triggers="$(sql "$DB_NAME" "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$DB_NAME'")"
dst_triggers="$(sql "$DRILL_DB" "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$DRILL_DB'")"
printf '  source=%s restored=%s\n' "$src_triggers" "$dst_triggers"
[ "$src_triggers" = "$dst_triggers" ] || die "trigger count differs"
sql "$DRILL_DB" "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$DRILL_DB' AND EVENT_OBJECT_TABLE = 'LedgerTransaction'" | grep -q . \
  || die "no trigger on LedgerTransaction in the restored database"

elapsed=$(( $(date +%s) - started ))
printf '\nRESTORE DRILL PASSED: %s -> %s, backup %s, %s tables / %s rows, %s triggers, %ss\n' \
  "$DB_NAME" "$DRILL_DB" "$(du -h "$backup" | cut -f1)" "$tables" "$rows" "$dst_triggers" "$elapsed"
