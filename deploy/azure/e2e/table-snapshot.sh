#!/usr/bin/env bash
# "<table> <rows> <checksum>" for every base table of the database the
# connection names (DATABASE_URL or MYSQL_*, scripts/db/lib.sh), sorted:
# deploy/azure/e2e.sh compares the source at dump time with the restore.
set -euo pipefail
# shellcheck source=../../../scripts/db/lib.sh
. /scripts/db/lib.sh
load_connection
tables="$(sql "$DB_NAME" "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1")"
[ -n "$tables" ] || die "no table in $DB_NAME"
counts=""; list=""
for t in $tables; do
  counts+="${counts:+ UNION ALL }SELECT '$t', COUNT(*) FROM \`$t\`"
  list+="${list:+, }\`$t\`"
done
LC_ALL=C join -j1 \
  <(sql "$DB_NAME" "$counts" | tr '\t' ' ' | LC_ALL=C sort -k1,1) \
  <(sql "$DB_NAME" "CHECKSUM TABLE $list" | sed "s/^$DB_NAME\.//" | tr '\t' ' ' | LC_ALL=C sort -k1,1)
