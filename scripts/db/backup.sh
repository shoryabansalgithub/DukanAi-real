#!/usr/bin/env bash
# MySQL 8 backup (roadmap 7.7, 9.2): one consistent, compressed logical dump
# of the DukaanAI database (tables, data, the ledger triggers, routines,
# events), written atomically next to a SHA-256 sidecar and a .meta sidecar
# (database, snapshot time, binary-log coordinates), then the oldest backups
# pruned. Runs wherever a MySQL 8 client is available: on the host, in CI, or
# in the compose stack (`docker compose --profile ops run --rm db-ops backup`).
#
#   scripts/db/backup.sh [--out DIR] [--keep N] [--label TEXT] [--coordinates auto|skip]
#
#   --out DIR           where to write (default: $BACKUP_DIR, else /var/backups/dukaanai)
#   --keep N            backups to keep in DIR, oldest removed first (default: $BACKUP_KEEP, else 14; 0 = keep all)
#   --label TEXT        appended to the file name (e.g. pre-release-1.4.0)
#   --coordinates MODE  auto (default): when the server writes a binary log, record the
#                       file and position of the snapshot in the dump and in .meta, so
#                       restore.sh --to can roll it forward to any second (mysqldump holds
#                       a global read lock for a moment to pin them: the user needs RELOAD
#                       and REPLICATION CLIENT); skip: never record them
#
# Connection: DATABASE_URL as the API reads it (mysql://user:pass@host:port/db?...)
# or MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE.
# The dump uses --single-transaction (a consistent InnoDB snapshot, no table
# locks, the API keeps running) and strips DEFINER clauses so the triggers
# restore under whichever user restores them. A trigger body that MySQL 8
# stored with its statement terminator (a multi-statement quirk; migration
# 20261003090100 recreates the ledger triggers so new databases are clean)
# would dump as `...; */;;`, which the mysql client refuses: that terminator
# is dropped too, so a backup taken before that migration restores as well.
# Records the success in BACKUP_STATUS_DIR (roadmap 9.4). Prints the backup path last.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

OUT="${BACKUP_DIR:-/var/backups/dukaanai}"
KEEP="${BACKUP_KEEP:-14}"
LABEL=""
COORDS="${BACKUP_COORDINATES:-auto}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --coordinates) COORDS="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$KEEP" in *[!0-9]*|"") die "--keep must be a whole number (got '$KEEP')" ;; esac
case "$LABEL" in *[!A-Za-z0-9._-]*) die "--label may only contain letters, digits, dot, underscore and dash" ;; esac
case "$COORDS" in auto|skip) ;; *) die "--coordinates must be auto or skip (got '$COORDS')" ;; esac

load_connection
require_clients
assert_server
mkdir -p "$OUT" 2>/dev/null || die "cannot create $OUT (pass --out DIR or set BACKUP_DIR)"
[ -w "$OUT" ] || die "$OUT is not writable (pass --out DIR or set BACKUP_DIR)"

taken_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="${taken_at//[-:]/}"
name="${DB_NAME}-${stamp}${LABEL:+-$LABEL}.sql.gz"
target="$OUT/$name"
partial="$OUT/.$name.partial"
trap 'rm -f "$partial"' EXIT

# Flags that only the MySQL 8 client knows (a MariaDB client dumps a MySQL 8
# server fine without them).
extra=()
help="$("$MYSQLDUMP_BIN" --help 2>/dev/null || true)"
case "$help" in *set-gtid-purged*) extra+=(--set-gtid-purged=OFF) ;; esac
case "$help" in *column-statistics*) extra+=(--column-statistics=0) ;; esac

# Binary-log coordinates (roadmap 9.2): the snapshot's file and position go
# into the dump as a comment (`--source-data=2`; `--master-data=2` on clients
# older than 8.0.26 and on MariaDB) and into the .meta sidecar.
coord_flag=""
if [ "$COORDS" = auto ]; then
  if binlog_enabled; then
    case "$help" in
      *source-data*) coord_flag="--source-data=2" ;;
      *master-data*) coord_flag="--master-data=2" ;;
    esac
    [ -n "$coord_flag" ] || printf 'WARNING: this mysqldump knows neither --source-data nor --master-data: the dump records no binary-log position and cannot be rolled forward\n' >&2
  else
    printf 'NOTE: binary logging is off on %s (log_bin=OFF): the dump records no binary-log position and cannot be rolled forward (restore.sh --to)\n' "$DB_HOST" >&2
  fi
fi
[ -z "$coord_flag" ] || extra+=("$coord_flag")

step "Dumping $DB_NAME from $DB_HOST:$DB_PORT (MySQL $(server_version)) to $target"
# pipefail: a failing mysqldump fails the pipeline even though gzip would exit 0.
if ! "$MYSQLDUMP_BIN" $(conn_args) \
  --single-transaction --quick --no-tablespaces \
  --routines --triggers --events --hex-blob \
  --default-character-set=utf8mb4 --skip-comments "${extra[@]}" \
  "$DB_NAME" \
  | sed -E 's#/\*!50017 DEFINER=`[^`]*`@`[^`]*`\*/##g; s#; \*/;;$# */;;#' \
  | gzip -c > "$partial"; then
  die "mysqldump failed${coord_flag:+ (with $coord_flag the backup user needs RELOAD and REPLICATION CLIENT; pass --coordinates skip to dump without a binary-log position)}"
fi
# A dump that ended early has no trailer: refuse to keep it.
gzip -dc "$partial" | tail -c 4096 | grep -q 'SQL_NOTES=@OLD_SQL_NOTES' || die "dump is incomplete (no trailer): nothing kept"
coords="$(dump_coordinates "$partial")"
if [ -n "$coord_flag" ] && [ -z "$coords" ]; then
  die "mysqldump ran with $coord_flag but the dump carries no binary-log position: nothing kept"
fi
mv "$partial" "$target"
( cd "$OUT" && sha256sum "$name" > "$name.sha256" )
{
  printf 'database=%s\n' "$DB_NAME"
  printf 'taken_at=%s\n' "$taken_at"
  printf 'server_version=%s\n' "$(server_version)"
  printf 'binlog_file=%s\n' "${coords%% *}"
  printf 'binlog_pos=%s\n' "${coords#* }"
} > "$target.meta"
trap - EXIT

if [ "$KEEP" -gt 0 ]; then
  # Oldest first by name (the UTC stamp sorts), keep the newest KEEP.
  ls -1 "$OUT"/"$DB_NAME"-*.sql.gz 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
    step "Pruning $(basename "$old")"
    rm -f "$old" "$old.sha256" "$old.meta"
  done
fi

size="$(du -h "$target" | cut -f1)"
record_success dump "$target"
if [ -n "$coords" ]; then
  step "Backup written: $target ($size; .sha256 and .meta sidecars; binary-log position ${coords%% *}:${coords#* }, snapshot at $taken_at)"
else
  step "Backup written: $target ($size; .sha256 and .meta sidecars; without binary-log coordinates)"
fi
printf '%s\n' "$target"
