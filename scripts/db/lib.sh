#!/usr/bin/env bash
# Shared by the backup / restore scripts (roadmap 7.7): connection settings
# from DATABASE_URL (as the API reads it) or MYSQL_* variables, the MySQL
# client binaries, and small helpers. Sourced, never run.

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Everything these scripts write (dumps, archives, manifests, binary logs,
# status stamps) holds the shop's data: owner-only, whatever the caller's
# umask (audit F9). The API reads the status stamps as the same uid (1000 in
# the images), so owner-only does not hide them from it.
umask 077

# Restricts a directory the scripts write into to its owner; a directory
# owned by someone else (a shared mount) is left alone with a warning.
private_dir() {
  chmod 700 "$1" 2>/dev/null || printf 'WARNING: could not restrict %s to its owner (chmod 700)\n' "$1" >&2
}

# Percent-decoding of a URL component, nothing else (audit P3): a '+' stays a
# '+' (it is not a space outside form encoding) and a backslash stays a
# backslash (the former printf %b turned "\n" in a password into a newline).
urldecode() {
  local s="$1" out="" ch
  while [ -n "$s" ]; do
    case "$s" in
      %[0-9A-Fa-f][0-9A-Fa-f]*)
        printf -v ch '%b' "\\x${s:1:2}"
        out+="$ch"
        s="${s:3}"
        ;;
      *)
        out+="${s:0:1}"
        s="${s:1}"
        ;;
    esac
  done
  printf '%s' "$out"
}

# Fills DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME, and the TLS settings the
# URL asks for (DB_SSL_MODE verify|require, DB_SSL_CA, DB_URL_TLS_QUERY: the
# URL's TLS parameters, for a URL the scripts build for another database).
# The other parameters of the query string (connection_limit, pool_timeout)
# are the API's business and are dropped.
load_connection() {
  DB_SSL_MODE=""; DB_SSL_CA=""; DB_URL_TLS_QUERY=""
  if [ -n "${DATABASE_URL:-}" ]; then
    case "$DATABASE_URL" in
      mysql://*) ;;
      *) die "DATABASE_URL must start with mysql:// (got ${DATABASE_URL%%:*}://...)" ;;
    esac
    local rest auth hostport_db hostport query pair key value sslaccept="" sslcert=""
    rest="${DATABASE_URL#mysql://}"
    query=""
    case "$rest" in *\?*) query="${rest#*\?}" ;; esac
    rest="${rest%%\?*}"
    # TLS (audit R9): the parameters Prisma reads. sslaccept=strict (Prisma's
    # default once TLS is configured) verifies the server certificate,
    # sslcert names the CA that signed it, sslaccept=accept_invalid_certs
    # encrypts without verifying (only when the URL says so).
    local pairs=()
    [ -z "$query" ] || IFS='&' read -r -a pairs <<<"$query"
    for pair in "${pairs[@]}"; do
      key="${pair%%=*}"; value="$(urldecode "${pair#*=}")"
      case "$key" in
        sslaccept) sslaccept="$value"; DB_URL_TLS_QUERY+="${DB_URL_TLS_QUERY:+&}$pair" ;;
        sslcert) sslcert="$value"; DB_URL_TLS_QUERY+="${DB_URL_TLS_QUERY:+&}$pair" ;;
      esac
    done
    case "$sslaccept" in
      strict) DB_SSL_MODE=verify ;;
      accept_invalid_certs) DB_SSL_MODE=require ;;
      "") [ -z "$sslcert" ] || DB_SSL_MODE=verify ;;
      *) die "DATABASE_URL: sslaccept must be strict or accept_invalid_certs (got '$sslaccept')" ;;
    esac
    if [ -n "$sslcert" ]; then
      [ -f "$sslcert" ] || die "DATABASE_URL names sslcert=$sslcert, which is not a readable file here (mount the CA certificate at the same path)"
      DB_SSL_CA="$sslcert"
    fi
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
    # The same TLS settings without a URL: MYSQL_SSL_MODE=verify|require, MYSQL_SSL_CA=<file>.
    DB_SSL_MODE="${MYSQL_SSL_MODE:-}"
    DB_SSL_CA="${MYSQL_SSL_CA:-}"
    case "$DB_SSL_MODE" in ""|verify|require) ;; *) die "MYSQL_SSL_MODE must be verify or require (got '$DB_SSL_MODE')" ;; esac
    [ -z "$DB_SSL_CA" ] || [ -f "$DB_SSL_CA" ] || die "MYSQL_SSL_CA=$DB_SSL_CA is not a readable file"
    [ -n "$DB_SSL_MODE" ] || [ -z "$DB_SSL_CA" ] || DB_SSL_MODE=verify
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

# TLS arguments for one client binary (audit R9), in that client's dialect:
# MySQL 8 clients verify with --ssl-mode=VERIFY_IDENTITY (VERIFY_CA when the
# host is an IP address, which a certificate rarely names), MariaDB clients
# with --ssl --ssl-verify-server-cert. A URL that asks for verification never
# gets an unverified connection: the client refuses, and so does the script.
tls_args() {
  local bin="${1:-$MYSQL_BIN}" version
  [ -n "${DB_SSL_MODE:-}" ] || return 0
  version="$("$bin" --version 2>/dev/null || true)"
  case "$version" in
    *MariaDB*)
      printf '%s\n' "--ssl"
      [ "$DB_SSL_MODE" != verify ] || printf '%s\n' "--ssl-verify-server-cert"
      ;;
    *)
      case "$DB_SSL_MODE" in
        verify)
          case "$DB_HOST" in
            *:*) printf '%s\n' "--ssl-mode=VERIFY_CA" ;;            # an IPv6 address (MYSQL_HOST)
            *[!0-9.]*) printf '%s\n' "--ssl-mode=VERIFY_IDENTITY" ;; # a name
            *) printf '%s\n' "--ssl-mode=VERIFY_CA" ;;               # an IPv4 address
          esac
          ;;
        require) printf '%s\n' "--ssl-mode=REQUIRED" ;;
      esac
      ;;
  esac
  [ -z "${DB_SSL_CA:-}" ] || printf '%s\n' "--ssl-ca=$DB_SSL_CA"
}

# Connection arguments for a client (default mysql; pass "$MYSQLDUMP_BIN" or
# "$MYSQLBINLOG_BIN" for those), no database.
conn_args() {
  printf '%s\n' "--host=$DB_HOST" "--port=$DB_PORT" "--user=$DB_USER" "--protocol=TCP"
  tls_args "${1:-$MYSQL_BIN}"
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
  # A drill exports its own BACKUP_STATUS_DIR (audit F5): it never stamps the operator's.
  if mkdir -p "$BACKUP_STATUS_DIR" 2>/dev/null && printf '%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$detail" > "$BACKUP_STATUS_DIR/.$kind.tmp" 2>/dev/null \
     && mv -f "$BACKUP_STATUS_DIR/.$kind.tmp" "$BACKUP_STATUS_DIR/$kind.last-success" 2>/dev/null; then
    return 0
  fi
  printf 'WARNING: could not record the %s success in %s (the stale-backup alert will fire)\n' "$kind" "$BACKUP_STATUS_DIR" >&2
}
