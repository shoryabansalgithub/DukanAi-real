#!/usr/bin/env bash
# Point-in-time markers (roadmap 9.2): two rows written a few seconds apart
# with a target time read from the server's clock between them, so a
# point-in-time restore to that time can be checked for exactly what it must
# contain: the first row and not the second.
#
#   scripts/db/pitr-markers.sh write   [--database NAME]
#   scripts/db/pitr-markers.sh verify  --run RUN --target-time TIME [--database NAME] [--cleanup]
#   scripts/db/pitr-markers.sh cleanup [--database NAME]
#
# write: creates the table `_pitr_drill` when it is missing, inserts marker A,
#   waits two seconds, reads the server's UTC clock (the target time), waits
#   two seconds, inserts marker B; prints `run=<id>` and `target_time=<UTC>`
#   as its last two lines. Binary-log event times have whole-second
#   resolution, which the gaps cover.
# verify: with DATABASE_URL on the restored copy, proves that marker A of
#   that run is present and marker B is absent; --cleanup drops the marker
#   table afterwards.
# cleanup: drops the marker table (on the database that received the writes,
#   which holds both markers and so cannot pass verify). Drop it on both
#   copies when the drill is over: `prisma migrate diff` reports the extra
#   table otherwise (the API's boot check does not, it only refuses a missing
#   table or column).
# restore-drill.sh uses both around restore.sh --to; the procedure for a
# managed provider's point-in-time restore is in docs/BACKUP_RESTORE.md.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -ge 1 ] || { sed -n '2,25p' "$0"; exit 2; }
CMD="$1"; shift
TARGET_DB=""
RUN=""
TARGET_TIME=""
CLEANUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --database) TARGET_DB="$2"; shift 2 ;;
    --run) RUN="$2"; shift 2 ;;
    --target-time) TARGET_TIME="$2"; shift 2 ;;
    --cleanup) CLEANUP=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_connection
require_clients
assert_server
TARGET_DB="${TARGET_DB:-$DB_NAME}"
assert_identifier "$TARGET_DB"
sql "$TARGET_DB" "SELECT 1" >/dev/null 2>&1 || die "database $TARGET_DB does not exist or is not accessible"

case "$CMD" in
  write)
    RUN="$(date -u +%Y%m%d%H%M%S)-$$"
    step "Point-in-time markers in $TARGET_DB (run $RUN)"
    sql "$TARGET_DB" "CREATE TABLE IF NOT EXISTS _pitr_drill (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, run VARCHAR(32) NOT NULL, marker CHAR(1) NOT NULL, writtenAt DATETIME(3) NOT NULL, INDEX _pitr_drill_run (run))"
    sql "$TARGET_DB" "INSERT INTO _pitr_drill (run, marker, writtenAt) VALUES ('$RUN', 'A', UTC_TIMESTAMP(3))"
    printf '  marker A written at %s UTC (server clock)\n' "$(sql "$TARGET_DB" "SELECT writtenAt FROM _pitr_drill WHERE run = '$RUN' AND marker = 'A'")"
    sleep 2
    TARGET_TIME="$(sqlx "SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s')")"
    sleep 2
    sql "$TARGET_DB" "INSERT INTO _pitr_drill (run, marker, writtenAt) VALUES ('$RUN', 'B', UTC_TIMESTAMP(3))"
    printf '  marker B written at %s UTC (server clock)\n' "$(sql "$TARGET_DB" "SELECT writtenAt FROM _pitr_drill WHERE run = '$RUN' AND marker = 'B'")"
    printf '  a restore to the target time must hold A and not B\n'
    printf 'run=%s\n' "$RUN"
    printf 'target_time=%s\n' "$TARGET_TIME"
    ;;
  verify)
    [ -n "$RUN" ] || die "verify needs --run RUN (printed by write)"
    [ -n "$TARGET_TIME" ] || die "verify needs --target-time TIME (printed by write)"
    TARGET_TIME="$(normalize_utc "$TARGET_TIME")"
    case "$RUN" in *[!A-Za-z0-9_-]*) die "not a run id: '$RUN'" ;; esac
    step "Point-in-time check of $TARGET_DB at $TARGET_TIME UTC (run $RUN)"
    sql "$TARGET_DB" "SELECT 1 FROM _pitr_drill LIMIT 1" >/dev/null 2>&1 || die "$TARGET_DB has no _pitr_drill table: the restore did not reach the markers (wrong archive, position or database?)"
    a="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM _pitr_drill WHERE run = '$RUN' AND marker = 'A'")"
    b="$(sql "$TARGET_DB" "SELECT COUNT(*) FROM _pitr_drill WHERE run = '$RUN' AND marker = 'B'")"
    written="$(sql "$TARGET_DB" "SELECT writtenAt FROM _pitr_drill WHERE run = '$RUN' AND marker = 'A'" 2>/dev/null || true)"
    printf '  marker A: %s row(s)%s; marker B: %s row(s)\n' "$a" "${written:+ (written $written UTC)}" "$b"
    [ "$a" = 1 ] || die "marker A (written before the target time) is missing: the restore stopped too early or replayed the wrong database"
    [ "$b" = 0 ] || die "marker B (written after the target time) is present: the restore went past the target time"
    if [ "$CLEANUP" = 1 ]; then
      sql "$TARGET_DB" "DROP TABLE IF EXISTS _pitr_drill"
      printf '  _pitr_drill dropped from %s\n' "$TARGET_DB"
    fi
    printf 'POINT-IN-TIME CHECK PASSED: %s holds the write before %s UTC and not the write after it\n' "$TARGET_DB" "$TARGET_TIME"
    ;;
  cleanup)
    sql "$TARGET_DB" "DROP TABLE IF EXISTS _pitr_drill"
    printf '_pitr_drill dropped from %s\n' "$TARGET_DB"
    ;;
  *) die "usage: pitr-markers.sh write | verify | cleanup (see --help)" ;;
esac
