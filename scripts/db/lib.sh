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

# MYSQL_BIN / MYSQLDUMP_BIN override the clients (e.g. a MySQL 8 client next to a MariaDB one).
MYSQL_BIN="${MYSQL_BIN:-mysql}"
MYSQLDUMP_BIN="${MYSQLDUMP_BIN:-mysqldump}"

require_clients() {
  command -v "$MYSQL_BIN" >/dev/null 2>&1 || die "mysql client not found (install mysql-client 8, or set MYSQL_BIN)"
  command -v "$MYSQLDUMP_BIN" >/dev/null 2>&1 || die "mysqldump not found (install mysql-client 8, or set MYSQLDUMP_BIN)"
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
