#!/usr/bin/env bash
# Restore a backup made by backup.sh into a MySQL 8 database (roadmap 7.7),
# optionally rolled forward to a point in time with the archived binary logs
# (roadmap 9.2).
#
#   scripts/db/restore.sh BACKUP.sql.gz [--database NAME] [--create] [--yes]
#                         [--to TIME] [--binlogs DIR] [--replay-database NAME]
#
#   --database NAME        restore into NAME instead of the database in DATABASE_URL
#   --create               CREATE DATABASE IF NOT EXISTS first (needs that privilege)
#   --yes                  actually restore; without it the plan is printed and nothing changes
#   --to TIME              after the dump, replay the archived binary logs from the position the
#                          dump recorded up to TIME (UTC, "YYYY-MM-DD HH:MM:SS" or
#                          "YYYY-MM-DDTHH:MM:SSZ"; the first event at or after TIME is not applied)
#   --binlogs DIR          the archive binlog-archive.sh fills (default: $BINLOG_ARCHIVE_DIR,
#                          else <backup dir>/binlog)
#   --replay-database NAME replay the events logged under NAME instead of the dump's database
#                          (the restore drill replays a scratch copy's events)
#
# The dump drops and re-creates every table it contains, so the target is
# replaced, not merged: stop the API (or restore into a fresh database and
# switch DATABASE_URL) before restoring over a live one. The SHA-256 sidecar
# is verified when present. When the user may switch binary logging off for
# its session (SUPER or SYSTEM_VARIABLES_ADMIN), the restore and the replay
# leave no trace in the server's own binary log. The replay rewrites the
# database name (mysqlbinlog --rewrite-db) when the target differs from the
# source, so a copy can be restored next to the live database, and applies
# only that database's events; executing the replayed BINLOG statements needs
# BINLOG_ADMIN (or REPLICATION_APPLIER) on the restoring user. Afterwards run,
# from apps/api with DATABASE_URL pointing at the restored database:
#   npx prisma migrate status
#   npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -ge 1 ] || { sed -n '2,32p' "$0"; exit 2; }
BACKUP="$1"; shift
TARGET_DB=""
CREATE=0
YES=0
TO=""
BINLOGS=""
REPLAY_DB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --database) TARGET_DB="$2"; shift 2 ;;
    --create) CREATE=1; shift ;;
    --yes) YES=1; shift ;;
    --to) TO="$2"; shift 2 ;;
    --binlogs) BINLOGS="$2"; shift 2 ;;
    --replay-database) REPLAY_DB="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -f "$BACKUP" ] || die "backup not found: $BACKUP"
[ -z "$REPLAY_DB" ] || [ -n "$TO" ] || die "--replay-database only makes sense with --to"

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

# What the dump says about itself: the .meta sidecar first, the dump header
# and the file name (<db>-<UTC stamp>) for a backup made before the sidecar existed.
SRC_DB="$(meta_get "$BACKUP" database)"
[ -n "$SRC_DB" ] || SRC_DB="$(basename "$BACKUP" | sed -E 's/-[0-9]{8}T[0-9]{6}Z.*$//')"
TAKEN_AT="$(meta_get "$BACKUP" taken_at)"
[ -n "$TAKEN_AT" ] || TAKEN_AT="$(basename "$BACKUP" | sed -nE 's/^.*-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z.*$/\1-\2-\3T\4:\5:\6Z/p')"
BL_FILE="$(meta_get "$BACKUP" binlog_file)"
BL_POS="$(meta_get "$BACKUP" binlog_pos)"
if [ -z "$BL_FILE" ]; then
  coords="$(dump_coordinates "$BACKUP")"
  BL_FILE="${coords%% *}"
  BL_POS="${coords#* }"
fi
[ -n "$BL_FILE" ] && [ -n "$BL_POS" ] || { BL_FILE=""; BL_POS=""; }

tables="$(gzip -dc "$BACKUP" | grep -c '^CREATE TABLE ' || true)"
step "Plan: restore $(basename "$BACKUP") ($(du -h "$BACKUP" | cut -f1), $tables tables, dump of $SRC_DB${TAKEN_AT:+ taken $TAKEN_AT}) into $TARGET_DB on $DB_HOST:$DB_PORT as $DB_USER"
if [ -n "$BL_FILE" ]; then
  printf '  binary-log position %s:%s: a point-in-time restore (--to) can roll it forward to any later second\n' "$BL_FILE" "$BL_POS"
else
  printf '  no binary-log position: the dump restores as it was taken; it cannot be rolled forward\n'
fi

# The replay plan (roadmap 9.2): the archived logs from the dump's file on,
# contiguous, each with its checksum.
files=()
if [ -n "$TO" ]; then
  require_binlog_client
  TO="$(normalize_utc "$TO")"
  [ -n "$BL_FILE" ] || die "point-in-time restore impossible: the dump carries no binary-log position (taken with --coordinates skip, with binary logging off, or before roadmap 9.2)"
  if [ -n "$TAKEN_AT" ]; then
    [ "$(utc_epoch "$TO")" -gt "$(utc_epoch "$TAKEN_AT")" ] || die "--to ($TO UTC) is not after the dump's snapshot ($TAKEN_AT): the dump alone is that state"
  fi
  REPLAY_DB="${REPLAY_DB:-$SRC_DB}"
  assert_identifier "$REPLAY_DB"
  BINLOGS="${BINLOGS:-${BINLOG_ARCHIVE_DIR:-$(dirname "$BACKUP")/binlog}}"
  [ -d "$BINLOGS" ] || die "binary-log archive not found: $BINLOGS (pass --binlogs DIR; binlog-archive.sh fills it)"
  [ -f "$BINLOGS/$BL_FILE" ] || die "the archive $BINLOGS has no $BL_FILE, the log the dump starts in (archive it before the server purges it: binlog_expire_logs_seconds)"
  prefix="${BL_FILE%.*}"
  expect=$((10#${BL_FILE##*.}))
  while read -r f; do
    [ -n "$f" ] || continue
    case "${f##*.}" in *[!0-9]*|"") continue ;; esac
    n=$((10#${f##*.}))
    [ "$n" -ge "$expect" ] || continue
    [ "$n" -eq "$expect" ] || die "gap in the archive: $(printf '%s.%06d' "$prefix" "$expect") is missing (the archive must be contiguous from $BL_FILE)"
    [ -f "$f.sha256" ] || die "no checksum for $(basename "$f") in the archive (not written by binlog-archive.sh, or still in flight)"
    ( cd "$BINLOGS" && sha256sum -c --quiet "$(basename "$f").sha256" ) || die "checksum mismatch: $(basename "$f") is damaged"
    files+=("$f")
    expect=$((expect + 1))
  done < <(ls -1 "$BINLOGS"/"$prefix".[0-9]* 2>/dev/null | grep -E "/$prefix\.[0-9]+\$" | sort)
  [ "${#files[@]}" -gt 0 ] || die "no binary log to replay in $BINLOGS"
  if [ "$REPLAY_DB" = "$TARGET_DB" ]; then
    printf '  then replay %s binary log(s) %s..%s from position %s up to %s UTC: the events of %s\n' "${#files[@]}" "$(basename "${files[0]}")" "$(basename "${files[${#files[@]}-1]}")" "$BL_POS" "$TO" "$REPLAY_DB"
  else
    printf '  then replay %s binary log(s) %s..%s from position %s up to %s UTC: the events of %s, rewritten to %s\n' "${#files[@]}" "$(basename "${files[0]}")" "$(basename "${files[${#files[@]}-1]}")" "$BL_POS" "$TO" "$REPLAY_DB" "$TARGET_DB"
  fi
fi

if [ "$YES" != 1 ]; then
  printf 'Dry run: pass --yes to restore (every table in the dump is dropped and re-created in %s).\n' "$TARGET_DB"
  exit 0
fi

init=()
if can_skip_session_binlog; then
  init=(--init-command="SET SESSION sql_log_bin = 0")
  printf '  binary logging is off for the restoring session: nothing of this restore enters the server'"'"'s binary log\n'
else
  printf 'NOTE: the user cannot switch session binary logging off (SUPER / SYSTEM_VARIABLES_ADMIN): the restore is written to the server'"'"'s binary log as well\n' >&2
fi

if [ "$CREATE" = 1 ]; then
  step "CREATE DATABASE IF NOT EXISTS $TARGET_DB"
  "$MYSQL_BIN" $(conn_args) -e "CREATE DATABASE IF NOT EXISTS \`$TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
fi
sql "$TARGET_DB" "SELECT 1" >/dev/null 2>&1 || die "database $TARGET_DB does not exist (pass --create) or is not accessible"

step "Restoring into $TARGET_DB"
started="$(date +%s)"
gzip -dc "$BACKUP" | "$MYSQL_BIN" $(conn_args) "${init[@]}" --database="$TARGET_DB"
elapsed=$(( $(date +%s) - started ))

restored="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$TARGET_DB'")"
migrations="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || echo 'n/a')"
triggers="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$TARGET_DB'")"
step "Restored $restored tables, $triggers triggers, $migrations applied migrations into $TARGET_DB in ${elapsed}s"

if [ -n "$TO" ]; then
  step "Replaying ${#files[@]} binary log(s) from $BL_FILE:$BL_POS up to $TO UTC into $TARGET_DB"
  rewrite=()
  [ "$REPLAY_DB" = "$TARGET_DB" ] || rewrite=(--rewrite-db="$REPLAY_DB->$TARGET_DB")
  started="$(date +%s)"
  # TZ=UTC: mysqlbinlog reads --stop-datetime in its own time zone. --rewrite-db
  # is applied before --database, so the filter names the rewritten database.
  # --skip-gtids: the events apply as new transactions whatever the GTID state.
  if ! TZ=UTC "$MYSQLBINLOG_BIN" --skip-gtids --start-position="$BL_POS" --stop-datetime="$TO" "${rewrite[@]}" --database="$TARGET_DB" "${files[@]}" \
      | "$MYSQL_BIN" $(conn_args) "${init[@]}" --database="$TARGET_DB"; then
    die "replay failed: $TARGET_DB holds the dump plus whatever applied before the error; drop it and restore again"
  fi
  elapsed=$(( $(date +%s) - started ))
  step "Replayed to $TO UTC in ${elapsed}s: $TARGET_DB is $REPLAY_DB as of that second"
fi
printf 'Next: from apps/api, with DATABASE_URL on %s, run `npx prisma migrate status` and the migrate diff (see the header of this script).\n' "$TARGET_DB"
