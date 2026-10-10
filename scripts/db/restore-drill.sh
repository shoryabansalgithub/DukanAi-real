#!/usr/bin/env bash
# Restore drill (roadmap 7.7, phase 7 exit gate; 9.2 point in time): proves
# that a backup made by backup.sh restores into a working database and that
# it rolls forward to any second with the archived binary logs. From a
# repository checkout:
#
#   DATABASE_URL=mysql://user:pass@host:3306/dukaanai scripts/db/restore-drill.sh [--keep] [--pitr auto|require|skip]
#
# Steps 1-6: back up the source database -> restore the file into a fresh
# scratch database on the same server (<db>_drill_<stamp>; the user needs
# CREATE DATABASE) -> `prisma migrate status` must be up to date and `prisma
# migrate diff` against schema.prisma must find no difference -> every table
# has the same row count on both sides -> the ledger triggers are present.
# Steps 7-9 (point in time): write marker A into the scratch copy, read a
# target time from the server's clock, write marker B -> archive the binary
# logs (binlog-archive.sh --flush) -> restore the same backup into a second
# scratch database rolled forward to the target time (restore.sh --to) and
# prove it holds A and not B while every other table equals the first copy
# (nothing duplicated, nothing lost). --pitr auto (default) skips steps 7-9
# with the reason when the server writes no binary log, the dump carries no
# position, mysqlbinlog is missing or the user cannot switch session binary
# logging off; require fails instead (CI); skip never runs them. Step 10
# (roadmap 9.5): the books of the restored copy are reconciled with
# `npm run reconcile` (the shop of the newest invoice, today's business day)
# and must come out exactly as the same reconciliation of the source: same
# status, drift count, checks and summary (a drift the source already
# carries is preserved, not hidden; a difference means the restore lost or
# changed a row). Skipped when the copy holds no invoice. Both scratch
# databases are dropped (--keep leaves them). Run it against a quiet source
# (CI after the integration suites, a staging copy, or production during a
# maintenance window): with writes in flight the counts differ and the drill
# fails, which is the point. Needs node and npm (prisma CLI and the
# reconcile script from apps/api), mysql, mysqldump and mysqlbinlog 8 on PATH (or MYSQL_BIN / MYSQLDUMP_BIN /
# MYSQLBINLOG_BIN).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

KEEP=0
PITR=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --pitr) PITR="$2"; shift 2 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$PITR" in auto|require|skip) ;; *) die "--pitr must be auto, require or skip (got '$PITR')" ;; esac

load_connection
require_clients
assert_server
command -v node >/dev/null 2>&1 || die "node is required (prisma migrate status / diff)"

stamp="$(date -u +%Y%m%d%H%M%S)"
DRILL_DB="${DB_NAME}_drill_${stamp}"
PITR_DB="${DB_NAME}_pitr_${stamp}"
assert_identifier "$DRILL_DB"
assert_identifier "$PITR_DB"
WORK="$(mktemp -d)"
started="$(date +%s)"
cleanup() {
  if [ "$KEEP" = 1 ]; then
    printf '\n--keep: scratch databases %s and %s left in place; backup and binary logs in %s\n' "$DRILL_DB" "$PITR_DB" "$WORK"
    return
  fi
  "$MYSQL_BIN" $(conn_args) -e "DROP DATABASE IF EXISTS \`$DRILL_DB\`; DROP DATABASE IF EXISTS \`$PITR_DB\`" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "1/10 Backup of $DB_NAME ($DB_HOST:$DB_PORT, MySQL $(server_version))"
backup="$(bash "$REPO/scripts/db/backup.sh" --out "$WORK" --keep 0 --label drill | tail -n 1)"
[ -f "$backup" ] || die "backup.sh did not produce a file"

step "2/10 Restore into scratch database $DRILL_DB"
bash "$REPO/scripts/db/restore.sh" "$backup" --database "$DRILL_DB" --create --yes

# The scratch database's URL for the Prisma CLI, credentials percent-encoded.
enc() { node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$1"; }
DRILL_URL="mysql://$(enc "$DB_USER"):$(enc "$DB_PASS")@$DB_HOST:$DB_PORT/$DRILL_DB"

step "3/10 prisma migrate status on $DRILL_DB (every migration applied, nothing pending)"
status="$(cd "$REPO/apps/api" && DATABASE_URL="$DRILL_URL" npx prisma migrate status 2>&1)" || { printf '%s\n' "$status"; die "migrate status failed"; }
printf '%s\n' "$status" | tail -n 3
printf '%s\n' "$status" | grep -q "Database schema is up to date" || die "the restored database has pending or unknown migrations"

step "4/10 prisma migrate diff: restored schema == prisma/schema.prisma"
( cd "$REPO/apps/api" && DATABASE_URL="$DRILL_URL" npx prisma migrate diff --from-url "$DRILL_URL" --to-schema-datamodel prisma/schema.prisma --exit-code ) \
  || die "the restored schema differs from schema.prisma"

# Every base table of DB_A has the same row count in DB_B; tables named in
# the third argument (space-separated) are skipped. Prints the summary line.
compare_counts() {
  local a="$1" b="$2" skip=" ${3:-} " table src dst mismatches=0 tables=0 rows=0
  while read -r table; do
    [ -n "$table" ] || continue
    case "$skip" in *" $table "*) continue ;; esac
    src="$(sql "$a" "SELECT COUNT(*) FROM \`$table\`")"
    dst="$(sql "$b" "SELECT COUNT(*) FROM \`$table\`" 2>/dev/null || echo missing)"
    tables=$((tables + 1))
    rows=$((rows + src))
    if [ "$src" != "$dst" ]; then
      printf '  MISMATCH %-40s %s=%s %s=%s\n' "$table" "$a" "$src" "$b" "$dst"
      mismatches=$((mismatches + 1))
    fi
  done < <(sql "$a" "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$a' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")
  printf '  %s tables, %s rows compared\n' "$tables" "$rows"
  [ "$tables" -gt 0 ] || die "$a has no tables"
  [ "$mismatches" -eq 0 ] || return 1
  COMPARED_TABLES="$tables"
  COMPARED_ROWS="$rows"
}

step "5/10 Row counts: every table of $DB_NAME has the same count in $DRILL_DB"
compare_counts "$DB_NAME" "$DRILL_DB" || die "table(s) differ (was the source written to during the drill?)"
tables="$COMPARED_TABLES"
rows="$COMPARED_ROWS"

step "6/10 Ledger immutability triggers restored"
src_triggers="$(sql "$DB_NAME" "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$DB_NAME'")"
dst_triggers="$(sql "$DRILL_DB" "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$DRILL_DB'")"
printf '  source=%s restored=%s\n' "$src_triggers" "$dst_triggers"
[ "$src_triggers" = "$dst_triggers" ] || die "trigger count differs"
sql "$DRILL_DB" "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$DRILL_DB' AND EVENT_OBJECT_TABLE = 'LedgerTransaction'" | grep -q . \
  || die "no trigger on LedgerTransaction in the restored database"

# Point in time (roadmap 9.2). The scratch copy plays the live database: its
# writes after the backup are the ones the restore must roll forward through.
pitr_reason=""
if [ "$PITR" = skip ]; then
  pitr_reason="--pitr skip"
else
  binlog_enabled || pitr_reason="the server writes no binary log (log_bin=OFF)"
  [ -n "$pitr_reason" ] || [ -n "$(dump_coordinates "$backup")" ] || pitr_reason="the dump carries no binary-log position"
  [ -n "$pitr_reason" ] || command -v "$MYSQLBINLOG_BIN" >/dev/null 2>&1 || pitr_reason="mysqlbinlog is not installed (MYSQLBINLOG_BIN)"
  [ -n "$pitr_reason" ] || can_skip_session_binlog || pitr_reason="the user cannot switch session binary logging off (SUPER / SYSTEM_VARIABLES_ADMIN), so the scratch restore itself would be replayed"
fi
pitr_result=""
if [ -n "$pitr_reason" ]; then
  [ "$PITR" != require ] || die "point-in-time drill impossible: $pitr_reason"
  step "7/10 Point-in-time drill skipped: $pitr_reason"
  pitr_result="point in time skipped ($pitr_reason)"
else
  step "7/10 Two writes after the backup in $DRILL_DB: marker A, a target time, marker B"
  markers="$(bash "$REPO/scripts/db/pitr-markers.sh" write --database "$DRILL_DB")"
  printf '%s\n' "$markers" | grep -v '^run=\|^target_time='
  run="$(printf '%s\n' "$markers" | sed -n 's/^run=//p')"
  target_time="$(printf '%s\n' "$markers" | sed -n 's/^target_time=//p')"
  [ -n "$run" ] && [ -n "$target_time" ] || die "pitr-markers.sh printed no run / target time"

  step "8/10 Archive the binary logs (binlog-archive.sh --flush) into $WORK/binlog"
  bash "$REPO/scripts/db/binlog-archive.sh" --out "$WORK/binlog" --flush --keep-days 0

  step "9/10 Restore the backup rolled forward to $target_time UTC into $PITR_DB: A present, B absent, every other table equal"
  replay_started="$(date +%s)"
  bash "$REPO/scripts/db/restore.sh" "$backup" --database "$PITR_DB" --create --yes --to "$target_time" --binlogs "$WORK/binlog" --replay-database "$DRILL_DB"
  replay_elapsed=$(( $(date +%s) - replay_started ))
  bash "$REPO/scripts/db/pitr-markers.sh" verify --database "$PITR_DB" --run "$run" --target-time "$target_time"
  compare_counts "$DRILL_DB" "$PITR_DB" "_pitr_drill" || die "the rolled-forward copy differs from the first copy outside the marker table: the replay duplicated or lost rows"
  pitr_result="point in time: marker before $target_time UTC kept, marker after it excluded, ${COMPARED_TABLES} tables equal (restore + replay ${replay_elapsed}s)"
fi

# Books of the restored copy (roadmap 9.5): the same reconciliation on both
# sides must agree in every figure. The CLI exits 0 when clean and 1 on
# drift (both are answers here); anything else is a failure of the run.
step "10/10 The restored copy's books reconcile exactly as the source's (npm run reconcile on $DRILL_DB and $DB_NAME)"
now_utc="$(date -u '+%Y-%m-%d %H:%M:%S')"
recon_shop="$(sql "$DRILL_DB" "SELECT shopId FROM Invoice WHERE createdAt <= '$now_utc' ORDER BY createdAt DESC, id DESC LIMIT 1")"
if [ -z "$recon_shop" ]; then
  recon_result="reconciliation skipped (the copy holds no invoice)"
  printf '  %s\n' "$recon_result"
else
  SOURCE_URL="mysql://$(enc "$DB_USER"):$(enc "$DB_PASS")@$DB_HOST:$DB_PORT/$DB_NAME"
  reconcile_json() {
    local out rc
    out="$(cd "$REPO/apps/api" && DATABASE_URL="$1" npm run --silent reconcile -- --shop "$recon_shop" --json 2>"$WORK/reconcile.err")" && rc=0 || rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 1 ] || { cat "$WORK/reconcile.err" >&2; die "npm run reconcile failed (exit $rc) against $1"; }
    printf '%s\n' "$out"
  }
  reconcile_json "$DRILL_URL" >"$WORK/recon-restored.json"
  reconcile_json "$SOURCE_URL" >"$WORK/recon-source.json"
  recon_result="$(node -e '
    const fs = require("fs");
    const pick = (file) => {
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      return { status: run.status, driftCount: run.driftCount, businessDate: run.businessDate, checks: run.checks, summary: run.summary };
    };
    const [restored, source] = [pick(process.argv[1]), pick(process.argv[2])];
    const same = JSON.stringify(restored) === JSON.stringify(source);
    const checks = restored.checks.map((c) => `${c.name}=${c.status}`).join(" ");
    if (!same) {
      console.error(`restored: ${JSON.stringify(restored)}\nsource:   ${JSON.stringify(source)}`);
      process.exit(1);
    }
    console.log(`books of shop ${process.argv[3]} on ${restored.businessDate}: ${restored.status} with ${restored.driftCount} drift(s) on both sides (${checks})`);
  ' "$WORK/recon-restored.json" "$WORK/recon-source.json" "$recon_shop")" || die "the restored copy's books differ from the source's for shop $recon_shop"
  printf '  %s\n' "$recon_result"
fi

elapsed=$(( $(date +%s) - started ))
printf '\nRESTORE DRILL PASSED: %s -> %s, backup %s, %s tables / %s rows, %s triggers; %s; %s; %ss\n' \
  "$DB_NAME" "$DRILL_DB" "$(du -h "$backup" | cut -f1)" "$tables" "$rows" "$dst_triggers" "$pitr_result" "$recon_result" "$elapsed"
