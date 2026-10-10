#!/usr/bin/env bash
# Shared by the backup / restore scripts (roadmap 7.7): connection settings
# from DATABASE_URL (as the API reads it) or MYSQL_* variables, the MySQL
# client binaries, and small helpers. Sourced, never run.

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

urldecode() {
  local s="${1//+/ }"
  printf '%b' "${s//%/\\x}"
}

# Fills DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME. The query string of the
# URL (connection_limit, pool_timeout) is the API's business and is dropped.
load_connection() {
  if [ -n "${DATABASE_URL:-}" ]; then
    case "$DATABASE_URL" in
      mysql://*) ;;
      *) die "DATABASE_URL must start with mysql:// (got ${DATABASE_URL%%:*}://...)" ;;
    esac
    local rest auth hostport_db hostport
    rest="${DATABASE_URL#mysql://}"
    rest="${rest%%\?*}"
    case "$rest" in
      *@*) auth="${rest%%@*}"; hostport_db="${rest#*@}" ;;
      *) auth=""; hostport_db="$rest" ;;
    esac
    hostport="${hostport_db%%/*}"
    DB_NAME="${hostport_db#*/}"
    DB_HOST="${hostport%%:*}"
    if [ "$hostport" = "$DB_HOST" ]; then DB_PORT=3306; else DB_PORT="${hostport#*:}"; fi
    case "$auth" in
      *:*) DB_USER="$(urldecode "${auth%%:*}")"; DB_PASS="$(urldecode "${auth#*:}")" ;;
      *) DB_USER="$(urldecode "$auth")"; DB_PASS="" ;;
    esac
  else
    DB_HOST="${MYSQL_HOST:-127.0.0.1}"
    DB_PORT="${MYSQL_PORT:-3306}"
    DB_USER="${MYSQL_USER:-root}"
    DB_PASS="${MYSQL_PASSWORD:-}"
    DB_NAME="${MYSQL_DATABASE:-}"
  fi
  [ -n "$DB_NAME" ] || die "no database name: set DATABASE_URL (mysql://user:pass@host:port/db) or MYSQL_DATABASE"
  [ -n "$DB_USER" ] || die "no database user: set DATABASE_URL or MYSQL_USER"
  # The password travels in the environment, never on a command line (visible in `ps`).
  export MYSQL_PWD="$DB_PASS"
}

# MYSQL_BIN / MYSQLDUMP_BIN / MYSQLBINLOG_BIN override the clients (e.g. a
# MySQL 8 client next to a MariaDB one: a MariaDB mysqlbinlog cannot read
# MySQL 8 binary logs).
MYSQL_BIN="${MYSQL_BIN:-mysql}"
MYSQLDUMP_BIN="${MYSQLDUMP_BIN:-mysqldump}"
MYSQLBINLOG_BIN="${MYSQLBINLOG_BIN:-mysqlbinlog}"

require_clients() {
  command -v "$MYSQL_BIN" >/dev/null 2>&1 || die "mysql client not found (install mysql-client 8, or set MYSQL_BIN)"
  command -v "$MYSQLDUMP_BIN" >/dev/null 2>&1 || die "mysqldump not found (install mysql-client 8, or set MYSQLDUMP_BIN)"
}

require_binlog_client() {
  command -v "$MYSQLBINLOG_BIN" >/dev/null 2>&1 || die "mysqlbinlog not found (install mysql-client 8, or set MYSQLBINLOG_BIN)"
}

# Connection arguments for the mysql / mysqldump clients (no database).
conn_args() {
  printf '%s\n' "--host=$DB_HOST" "--port=$DB_PORT" "--user=$DB_USER" "--protocol=TCP"
}

# Runs a statement (or stdin when no argument) against DATABASE, as the current connection.
sql() {
  local database="$1"; shift
  if [ $# -gt 0 ]; then
    "$MYSQL_BIN" $(conn_args) --batch --skip-column-names --database="$database" -e "$*"
  else
    "$MYSQL_BIN" $(conn_args) --batch --skip-column-names --database="$database"
  fi
}

# Verifies the server answers before anything is dumped or restored.
assert_server() {
  "$MYSQL_BIN" $(conn_args) --batch --skip-column-names -e "SELECT 1" >/dev/null 2>&1 || die "cannot connect to MySQL at $DB_HOST:$DB_PORT as $DB_USER"
}

server_version() {
  "$MYSQL_BIN" $(conn_args) --batch --skip-column-names -e "SELECT VERSION()"
}

# Rejects anything but a plain identifier for a database name used in SQL.
assert_identifier() {
  case "$1" in
    *[!A-Za-z0-9_]*|"") die "not a plain database name: '$1'" ;;
  esac
}

# Runs a statement with no default database.
sqlx() {
  "$MYSQL_BIN" $(conn_args) --batch --skip-column-names -e "$*"
}

# True when the server writes a binary log (MySQL 8 default: log_bin=ON).
binlog_enabled() {
  [ "$(sqlx "SHOW VARIABLES LIKE 'log_bin'" 2>/dev/null | awk '{print $2}')" = "ON" ]
}

# "<file> <position>" of the log the server is writing now. MySQL 8.4 removed
# SHOW MASTER STATUS and 8.0 does not know SHOW BINARY LOG STATUS: try both.
# Needs REPLICATION CLIENT.
binlog_status() {
  local out
  out="$(sqlx "SHOW BINARY LOG STATUS" 2>/dev/null)" || out="$(sqlx "SHOW MASTER STATUS" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | awk 'NR == 1 { print $1, $2 }'
}

# True when this user may switch binary logging off for its own session
# (SUPER or SYSTEM_VARIABLES_ADMIN): a restore then leaves no trace in the
# server's binary log and a replay never re-logs what it applies.
can_skip_session_binlog() {
  sqlx "SET SESSION sql_log_bin = 0" >/dev/null 2>&1
}

# The first lines of a dump (gzip may be cut short by head: that is fine).
dump_head() {
  { gzip -dc "$1" 2>/dev/null || true; } | head -n 60
}

# The binary-log coordinates a dump carries: `--source-data=2` /
# `--master-data=2` write them as a comment in the first lines (8.0 clients
# say CHANGE MASTER TO, 8.4 clients CHANGE REPLICATION SOURCE TO). Prints
# "<file> <position>" or nothing.
dump_coordinates() {
  local line file pos
  line="$(dump_head "$1" | grep -m1 -oE "(MASTER|SOURCE)_LOG_FILE='[^']+', (MASTER|SOURCE)_LOG_POS=[0-9]+" || true)"
  [ -n "$line" ] || return 0
  file="${line#*_LOG_FILE=\'}"; file="${file%%\'*}"
  pos="${line##*_LOG_POS=}"
  printf '%s %s\n' "$file" "$pos"
}

# A value from the .meta sidecar backup.sh writes next to a dump (key=value lines).
meta_get() {
  sed -n "s/^$2=//p" "$1.meta" 2>/dev/null | head -n 1
}

# "2026-10-05T16:30:45Z" or "2026-10-05 16:30:45" -> "2026-10-05 16:30:45" (UTC).
normalize_utc() {
  local t="$1"
  t="${t/T/ }"; t="${t%Z}"
  case "$t" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\ [0-9][0-9]:[0-9][0-9]:[0-9][0-9]) printf '%s\n' "$t" ;;
    *) die "not a UTC time like 2026-10-05 16:30:45 or 2026-10-05T16:30:45Z: '$1'" ;;
  esac
}

utc_epoch() {
  date -u -d "${1/T/ }" +%s 2>/dev/null || die "cannot parse time '$1'"
}

# Backup monitoring (roadmap 9.4): every backup job records its last success
# as <BACKUP_STATUS_DIR>/<kind>.last-success (first line: the UTC time,
# second: a detail), which the API turns into the
# backup_last_success_timestamp_seconds{kind} gauge and the stale-backup
# alert watches. A stamp that cannot be written is a warning, never a failed
# backup: the alert then fires, which is the point.
BACKUP_STATUS_DIR="${BACKUP_STATUS_DIR:-${BACKUP_DIR:-/var/backups/dukaanai}/status}"
record_success() {
  local kind="$1" detail="${2:-}"
  case "$kind" in *[!a-z]*|"") die "record_success: kind must be lower-case letters (got '$kind')" ;; esac
  if mkdir -p "$BACKUP_STATUS_DIR" 2>/dev/null && printf '%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$detail" > "$BACKUP_STATUS_DIR/.$kind.tmp" 2>/dev/null \
     && mv -f "$BACKUP_STATUS_DIR/.$kind.tmp" "$BACKUP_STATUS_DIR/$kind.last-success" 2>/dev/null; then
    return 0
  fi
  printf 'WARNING: could not record the %s success in %s (the stale-backup alert will fire)\n' "$kind" "$BACKUP_STATUS_DIR" >&2
}
