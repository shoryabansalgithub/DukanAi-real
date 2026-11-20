#!/usr/bin/env bash
# Binary-log archive (roadmap 9.2): copies the closed binary logs of the
# server into an archive directory next to the dumps, so restore.sh --to can
# roll a dump forward to any second. Run it every few minutes; the recovery
# point is the interval:
#
#   */5 * * * *  DATABASE_URL=... scripts/db/binlog-archive.sh --flush
#   docker compose --profile ops run --rm db-ops binlog-archive --flush
#
#   --out DIR      archive directory (default: $BINLOG_ARCHIVE_DIR, else $BACKUP_DIR/binlog,
#                  else /var/backups/dukaanai/binlog)
#   --flush        FLUSH BINARY LOGS first, so the log being written is closed and archived
#                  too (without it the open log waits until the server rotates it, which on a
#                  quiet server is max_binlog_size away); needs RELOAD
#   --keep-days N  remove logs archived more than N days ago (default: $BINLOG_ARCHIVE_KEEP_DAYS,
#                  else 7; 0 = keep all), but never a log a kept dump still needs: nothing
#                  from the binary-log file recorded in the oldest dump's .meta on is removed
#                  (audit F7), and nothing at all when no dump with a position is found
#   --dumps DIR    where the dumps (and their .meta) are; repeatable for an hourly set
#                  in its own directory (default: $BACKUP_DIR, else /var/backups/dukaanai)
#
# The logs are read over the connection with `mysqlbinlog --read-from-remote-server
# --raw` (no access to the data directory; the user needs REPLICATION SLAVE and
# REPLICATION CLIENT), written as .inflight.<name> first, kept only when the
# size equals the server's, then renamed next to a SHA-256 sidecar. A log that
# is already in the archive with the right size is skipped, so a run is
# idempotent; a log the server has purged (binlog_expire_logs_seconds) but the
# archive holds stays. Records the success in BACKUP_STATUS_DIR (roadmap
# 9.4). Exit 0 only when every closed log is in the archive.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

OUT="${BINLOG_ARCHIVE_DIR:-${BACKUP_DIR:-/var/backups/dukaanai}/binlog}"
FLUSH=0
KEEP_DAYS="${BINLOG_ARCHIVE_KEEP_DAYS:-7}"
DUMP_DIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --flush) FLUSH=1; shift ;;
    --keep-days) KEEP_DAYS="$2"; shift 2 ;;
    --dumps) DUMP_DIRS+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$KEEP_DAYS" in *[!0-9]*|"") die "--keep-days must be a whole number (got '$KEEP_DAYS')" ;; esac
[ "${#DUMP_DIRS[@]}" -gt 0 ] || DUMP_DIRS=("${BACKUP_DIR:-/var/backups/dukaanai}")

load_connection
require_clients
require_binlog_client
assert_server
binlog_enabled || die "binary logging is off on $DB_HOST:$DB_PORT (log_bin=OFF): nothing to archive. MySQL 8 writes one by default; keep binlog_expire_logs_seconds above the archive interval"
mkdir -p "$OUT" 2>/dev/null || die "cannot create $OUT (pass --out DIR or set BINLOG_ARCHIVE_DIR)"
[ -w "$OUT" ] || die "$OUT is not writable (pass --out DIR or set BINLOG_ARCHIVE_DIR)"
private_dir "$OUT"

if [ "$FLUSH" = 1 ]; then
  sqlx "FLUSH BINARY LOGS" >/dev/null 2>&1 || die "FLUSH BINARY LOGS failed: the user needs RELOAD (or run without --flush)"
fi
current="$(binlog_status | awk '{ print $1 }')" || true
[ -n "$current" ] || die "cannot read the current binary log (SHOW BINARY LOG STATUS / SHOW MASTER STATUS need REPLICATION CLIENT)"
logs="$(sqlx "SHOW BINARY LOGS" 2>/dev/null)" || die "SHOW BINARY LOGS failed: the user needs REPLICATION CLIENT"

step "Archiving the closed binary logs of $DB_HOST:$DB_PORT (MySQL $(server_version)) into $OUT"
archived=0
skipped=0
newest=""
prefix=""
while read -r name size encrypted; do
  [ -n "$name" ] || continue
  [ "$name" != "$current" ] || continue
  [ "${encrypted:-No}" != "Yes" ] || die "$name is encrypted on the server (binlog_encryption): a raw copy cannot be replayed; archive with the key or switch the encryption off"
  prefix="${name%.*}"
  newest="$name"
  if [ -f "$OUT/$name" ] && [ "$(stat -c %s "$OUT/$name")" = "$size" ] && [ -f "$OUT/$name.sha256" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  rm -f "$OUT/.inflight.$name" "$OUT/.inflight.err"
  if ! "$MYSQLBINLOG_BIN" $(conn_args "$MYSQLBINLOG_BIN") --read-from-remote-server --raw --result-file="$OUT/.inflight." "$name" 2>"$OUT/.inflight.err"; then
    err="$(cat "$OUT/.inflight.err" 2>/dev/null || true)"
    rm -f "$OUT/.inflight.$name" "$OUT/.inflight.err"
    die "could not read $name from the server: ${err:-mysqlbinlog failed} (the user needs REPLICATION SLAVE)"
  fi
  rm -f "$OUT/.inflight.err"
  got="$(stat -c %s "$OUT/.inflight.$name")"
  if [ "$got" != "$size" ]; then
    rm -f "$OUT/.inflight.$name"
    die "$name: copied $got bytes but the server reports $size: the log was still being written or was rotated; run again"
  fi
  mv -f "$OUT/.inflight.$name" "$OUT/$name"
  ( cd "$OUT" && sha256sum "$name" > "$name.sha256" )
  archived=$((archived + 1))
  printf '  archived %s (%s bytes)\n' "$name" "$size"
done <<< "$logs"

if [ "$KEEP_DAYS" -gt 0 ] && [ -n "$prefix" ]; then
  # The oldest log any kept dump starts in (audit F7): pruning by age alone
  # removed logs the oldest dump still needs to be rolled forward (a dump
  # kept 14 days, logs kept 7). Only a dump that is there counts, and
  # without any dump that records a position nothing is pruned.
  needed=""
  for dir in "${DUMP_DIRS[@]}"; do
    for meta in "$dir"/*.sql.gz.meta; do
      [ -f "$meta" ] && [ -f "${meta%.meta}" ] || continue
      file="$(sed -n 's/^binlog_file=//p' "$meta" | head -n 1)"
      case "$file" in "$prefix".[0-9]*) ;; *) continue ;; esac
      seq=$((10#${file##*.}))
      if [ -z "$needed" ] || [ "$seq" -lt "$needed" ]; then needed="$seq"; fi
    done
  done
  if [ -z "$needed" ]; then
    printf 'NOTE: no dump with a binary-log position in %s: nothing pruned (pass --dumps DIR)\n' "${DUMP_DIRS[*]}" >&2
  else
    while IFS= read -r -d '' old; do
      base="$(basename "$old")"
      seq="${base#"$prefix".}"; seq="${seq%.sha256}"
      case "$seq" in *[!0-9]*|"") continue ;; esac
      [ "$((10#$seq))" -lt "$needed" ] || continue
      rm -f "$old"
      printf '  pruned %s\n' "$old"
    done < <(find "$OUT" -maxdepth 1 -type f -regex ".*/$prefix\.[0-9]+\(\.sha256\)?" -mtime +"$KEEP_DAYS" -print0)
  fi
fi

record_success binlog "${newest:-none}"
if [ -z "$newest" ]; then
  step "No closed binary log yet: the server is still writing $current (run with --flush to close it)"
else
  step "Binary-log archive $OUT: archived $archived file(s), $skipped already there, newest $newest; the server is writing $current"
fi
