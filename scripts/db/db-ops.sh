#!/usr/bin/env bash
# Entrypoint of the compose `db-ops` service (roadmap 7.7, 9.2): a MySQL 8
# client container with the backup scripts mounted at /scripts, the backups
# volume at /backups and the binary-log archive at /backups/binlog.
#
#   docker compose --profile ops run --rm db-ops backup [--label TEXT]       # nightly
#   docker compose --profile ops run --rm db-ops binlog-archive --flush      # every 5 minutes (cron)
#   docker compose --profile ops up -d binlog-archiver                       # or: the same, as a service
#   docker compose --profile ops run --rm db-ops documents-backup            # nightly: evidence + product images (9.3)
#   docker compose --profile ops run --rm db-ops offsite push|check|list|fetch DIR   # encrypted off-site copy (9.4)
#   docker compose --profile ops run --rm db-ops restore /backups/<file>.sql.gz --yes [--to "YYYY-MM-DD HH:MM:SS"]
#   docker compose --profile ops run --rm db-ops documents-restore ARCHIVE --to DIR --yes
#   docker compose --profile ops run --rm db-ops list                        # dumps and the archive
#   docker compose --profile ops run --rm db-ops status                      # every job's last success
#   docker compose --profile ops run --rm db-ops latest                      # path of the newest dump
# The repository's scripts/ directory is mounted at /scripts.
set -euo pipefail
cmd="${1:-}"; shift || true
BACKUPS="${BACKUP_DIR:-/backups}"
ARCHIVE="${BINLOG_ARCHIVE_DIR:-$BACKUPS/binlog}"
case "$cmd" in
  backup) exec bash /scripts/db/backup.sh "$@" ;;
  binlog-archive) exec bash /scripts/db/binlog-archive.sh "$@" ;;
  documents-backup) exec bash /scripts/storage/backup.sh "$@" ;;
  documents-restore) exec bash /scripts/storage/restore.sh "$@" ;;
  offsite) exec bash /scripts/backup/offsite.sh "$@" ;;
  archive-loop)
    # The binlog-archiver service: an archive run with --flush every
    # BINLOG_ARCHIVE_INTERVAL_SECONDS (300), for a stack without host cron.
    interval="${BINLOG_ARCHIVE_INTERVAL_SECONDS:-300}"
    echo "binlog-archiver: archiving into $ARCHIVE every ${interval}s"
    # The loop is PID 1 of its container, and bash ignores SIGTERM there
    # without a trap: every stop waited out the grace period and was killed
    # (exit 137; found walking DukaanAiBackupStale, roadmap 9.22). A run in
    # progress finishes first (bash runs the trap once its child exits); the
    # sleep is waited on, so a stop between runs is immediate.
    trap 'echo "binlog-archiver: stopping"; exit 0' TERM INT
    while true; do
      bash /scripts/db/binlog-archive.sh --flush "$@" || echo "binlog-archiver: run failed (exit $?), next try in ${interval}s" >&2
      sleep "$interval" & wait $!
    done
    ;;
  backup-loop)
    # The backup-agent service / sidecar (roadmap 9.7): without host cron, run
    # the nightly set every BACKUP_LOOP_INTERVAL_SECONDS (86400): a dump of the
    # database, the documents archive (STORAGE_ROOT, MEDIA_DIR when set) and,
    # when OFFSITE_REMOTE is configured, the encrypted off-site copy. A failed
    # job is logged and the next one still runs; each success stamps
    # BACKUP_STATUS_DIR for the backup metric, so a job that keeps failing
    # raises DukaanAiBackupStale.
    interval="${BACKUP_LOOP_INTERVAL_SECONDS:-86400}"
    delay="${BACKUP_LOOP_INITIAL_DELAY_SECONDS:-60}"
    echo "backup-agent: dump + documents${OFFSITE_REMOTE:++ off-site} into $BACKUPS every ${interval}s (first run in ${delay}s)"
    # PID 1 too: stop at once between runs, after the current job during one (archive-loop above).
    trap 'echo "backup-agent: stopping"; exit 0' TERM INT
    sleep "$delay" & wait $!
    while true; do
      bash /scripts/db/backup.sh || echo "backup-agent: dump failed (exit $?)" >&2
      bash /scripts/storage/backup.sh || echo "backup-agent: documents archive failed (exit $?)" >&2
      if [ -n "${OFFSITE_REMOTE:-}" ]; then
        bash /scripts/backup/offsite.sh push || echo "backup-agent: off-site copy failed (exit $?)" >&2
      else
        echo "backup-agent: OFFSITE_REMOTE is not set: no off-site copy (docs/BACKUP_RESTORE.md)" >&2
      fi
      sleep "$interval" & wait $!
    done
    ;;
  restore) exec bash /scripts/db/restore.sh "$@" ;;
  list)
    ls -lh "$BACKUPS"/*.sql.gz 2>/dev/null || echo "no backups in $BACKUPS"
    ls -lh "${DOCUMENTS_BACKUP_DIR:-$BACKUPS/documents}"/*.tar.gz 2>/dev/null || echo "no documents archive in ${DOCUMENTS_BACKUP_DIR:-$BACKUPS/documents}"
    if [ -d "$ARCHIVE" ]; then
      n="$(find "$ARCHIVE" -maxdepth 1 -type f ! -name '*.sha256' ! -name '.*' | wc -l)"
      echo "binary-log archive $ARCHIVE: $n file(s)"
    else
      echo "no binary-log archive in $ARCHIVE (run binlog-archive --flush)"
    fi
    ;;
  status)
    for f in "${BACKUP_STATUS_DIR:-$BACKUPS/status}"/*.last-success; do
      [ -f "$f" ] || { echo "no backup has recorded a success in ${BACKUP_STATUS_DIR:-$BACKUPS/status}"; break; }
      printf '%-10s %s  %s\n' "$(basename "$f" .last-success)" "$(sed -n 1p "$f")" "$(sed -n 2p "$f")"
    done
    ;;
  latest) ls -1 "$BACKUPS"/*.sql.gz 2>/dev/null | sort | tail -n 1 ;;
  *) echo "usage: db-ops backup [--label TEXT] | binlog-archive [--flush] | archive-loop | backup-loop | documents-backup | documents-restore ARCHIVE ... | offsite push|check|list|fetch DIR | restore FILE --yes [--to TIME] | list | status | latest" >&2; exit 2 ;;
esac
