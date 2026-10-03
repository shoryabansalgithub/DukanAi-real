#!/usr/bin/env bash
# MySQL 8 backup (roadmap 7.7): one consistent, compressed logical dump of the
# DukaanAI database (tables, data, the ledger triggers, routines, events),
# written atomically next to a SHA-256 sidecar, then the oldest backups
# pruned. Runs wherever a MySQL 8 client is available: on the host, in CI, or
# in the compose stack (`docker compose --profile ops run --rm db-ops backup`).
#
#   scripts/db/backup.sh [--out DIR] [--keep N] [--label TEXT]
#
#   --out DIR     where to write (default: $BACKUP_DIR, else /var/backups/dukaanai)
#   --keep N      backups to keep in DIR, oldest removed first (default: $BACKUP_KEEP, else 14; 0 = keep all)
#   --label TEXT  appended to the file name (e.g. pre-release-1.4.0)
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
# Prints the backup path last.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

OUT="${BACKUP_DIR:-/var/backups/dukaanai}"
KEEP="${BACKUP_KEEP:-14}"
LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$KEEP" in *[!0-9]*|"") die "--keep must be a whole number (got '$KEEP')" ;; esac
case "$LABEL" in *[!A-Za-z0-9._-]*) die "--label may only contain letters, digits, dot, underscore and dash" ;; esac

load_connection
require_clients
assert_server
mkdir -p "$OUT" 2>/dev/null || die "cannot create $OUT (pass --out DIR or set BACKUP_DIR)"
[ -w "$OUT" ] || die "$OUT is not writable (pass --out DIR or set BACKUP_DIR)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
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

step "Dumping $DB_NAME from $DB_HOST:$DB_PORT (MySQL $(server_version)) to $target"
# pipefail: a failing mysqldump fails the script even though gzip would exit 0.
"$MYSQLDUMP_BIN" $(conn_args) \
  --single-transaction --quick --no-tablespaces \
  --routines --triggers --events --hex-blob \
  --default-character-set=utf8mb4 --skip-comments "${extra[@]}" \
  "$DB_NAME" \
  | sed -E 's#/\*!50017 DEFINER=`[^`]*`@`[^`]*`\*/##g; s#; \*/;;$# */;;#' \
  | gzip -c > "$partial"
# A dump that ended early has no trailer: refuse to keep it.
gzip -dc "$partial" | tail -c 4096 | grep -q 'SQL_NOTES=@OLD_SQL_NOTES' || die "dump is incomplete (no trailer): nothing kept"
mv "$partial" "$target"
( cd "$OUT" && sha256sum "$name" > "$name.sha256" )
trap - EXIT

if [ "$KEEP" -gt 0 ]; then
  # Oldest first by name (the UTC stamp sorts), keep the newest KEEP.
  ls -1 "$OUT"/"$DB_NAME"-*.sql.gz 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
    step "Pruning $(basename "$old")"
    rm -f "$old" "$old.sha256"
  done
fi

size="$(du -h "$target" | cut -f1)"
step "Backup written: $target ($size, sha256 in $name.sha256)"
printf '%s\n' "$target"
