#!/usr/bin/env bash
# The database users of the Azure target, created by the server admin (the
# account the Bicep deployment made; deploy/azure/stack.sh up runs this first
# on every deploy, in the db-ops image as compose service `db-init`):
#
#   dukaanai          ALL on the application database only: the API and the
#                     release step (DATABASE_URL)
#   dukaanai_backup   SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES on it:
#                     what mysqldump --single-transaction --routines
#                     --triggers --events needs (DB_OPS_DATABASE_URL)
#
# Users, passwords and the database come from the two URLs the containers
# connect with, so they cannot disagree; running it again converges both
# users on those passwords and grants. The Azure admin holds no dynamic
# privilege, so it cannot grant SHOW_ROUTINE: the schema has no stored
# routine today, and a warning says so if one appears (mysqldump would leave
# it out silently). No RELOAD / REPLICATION CLIENT either: the dumps record
# no binary-log position (BACKUP_COORDINATES=skip; point in time is Azure's
# own restore).
#
# Environment: AZURE_MYSQL_HOST, AZURE_MYSQL_ADMIN_USER,
# AZURE_MYSQL_ADMIN_PASSWORD, APP_DATABASE_URL, BACKUP_DATABASE_URL, and the
# CA bundle at DB_CA (default /etc/dukaanai/db-ca.pem): the admin connects
# over TLS with the server's name verified.
set -euo pipefail
# shellcheck source=../../scripts/db/lib.sh
. "${DB_OPS_LIB:-/scripts/db/lib.sh}"

host="${AZURE_MYSQL_HOST:-}"; admin="${AZURE_MYSQL_ADMIN_USER:-}"; admin_pw="${AZURE_MYSQL_ADMIN_PASSWORD:-}"
[ -n "$host" ] || die "AZURE_MYSQL_HOST is not set (the deployment output mysqlFqdn)"
[ -n "$admin" ] && [ -n "$admin_pw" ] || die "AZURE_MYSQL_ADMIN_USER and AZURE_MYSQL_ADMIN_PASSWORD must be set (the server admin of the deployment)"
[ -n "${APP_DATABASE_URL:-}" ] && [ -n "${BACKUP_DATABASE_URL:-}" ] || die "DATABASE_URL and DB_OPS_DATABASE_URL must both be set"

# user password database host of one URL, checked: the values go into SQL
# literals unescaped, and both URLs must name the admin's server.
account() {
  DATABASE_URL="$1" load_connection
  case "$DB_USER$DB_NAME" in *[!A-Za-z0-9_]*) die "$2: user and database must be plain identifiers (got '$DB_USER', '$DB_NAME')" ;; esac
  case "$DB_PASS" in *[!A-Za-z0-9._~-]*) die "$2: the password may only hold letters, digits and ._~- (openssl rand -hex 32)" ;; esac
  [ "${#DB_PASS}" -ge 32 ] || die "$2: the password must be at least 32 characters (openssl rand -hex 32)"
  [ "$DB_HOST" = "$host" ] || die "$2 points at $DB_HOST, not AZURE_MYSQL_HOST ($host)"
  [ "$DB_SSL_MODE" = verify ] || die "$2 must verify the server certificate (?sslaccept=strict&sslcert=/etc/dukaanai/db-ca.pem)"
  printf '%s %s %s\n' "$DB_USER" "$DB_PASS" "$DB_NAME"
}
read -r app_user app_pw db < <(account "$APP_DATABASE_URL" DATABASE_URL)
read -r backup_user backup_pw backup_db < <(account "$BACKUP_DATABASE_URL" DB_OPS_DATABASE_URL)
[ "$backup_db" = "$db" ] || die "DATABASE_URL names database $db, DB_OPS_DATABASE_URL $backup_db"
[ "$backup_user" != "$app_user" ] || die "the backup user must not be the application user ($app_user)"
[ "$app_user" != "$admin" ] && [ "$backup_user" != "$admin" ] || die "the admin account is never a runtime user"

unset DATABASE_URL
MYSQL_HOST="$host" MYSQL_PORT=3306 MYSQL_USER="$admin" MYSQL_PASSWORD="$admin_pw" MYSQL_DATABASE="$db" \
  MYSQL_SSL_MODE=verify MYSQL_SSL_CA="${DB_CA:-/etc/dukaanai/db-ca.pem}" load_connection
require_clients
assert_server

step "Converging $app_user and $backup_user on $host as $admin (MySQL $(server_version))"
mapfile -t args < <(conn_args)
# CREATE USER, even with IF NOT EXISTS, is refused (ERROR 4006) for an account
# that is the DEFINER of a trigger, which the app user is once the ledger
# migration ran: an existing account is only altered.
create_or_alter() {
  if "$MYSQL_BIN" "${args[@]}" --batch --skip-column-names -e "SHOW GRANTS FOR '$1'@'%'" >/dev/null 2>&1; then
    printf "ALTER USER '%s'@'%%' IDENTIFIED BY '%s';\n" "$1" "$2"
  else
    printf "CREATE USER '%s'@'%%' IDENTIFIED BY '%s';\n" "$1" "$2"
  fi
}
# SQL on stdin: the passwords never appear in a process's arguments.
"$MYSQL_BIN" "${args[@]}" --batch --skip-column-names <<SQL
CREATE DATABASE IF NOT EXISTS \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
$(create_or_alter "$app_user" "$app_pw")
REVOKE ALL PRIVILEGES, GRANT OPTION FROM '$app_user'@'%';
GRANT ALL PRIVILEGES ON \`$db\`.* TO '$app_user'@'%';
$(create_or_alter "$backup_user" "$backup_pw")
REVOKE ALL PRIVILEGES, GRANT OPTION FROM '$backup_user'@'%';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON \`$db\`.* TO '$backup_user'@'%';
SHOW GRANTS FOR '$app_user'@'%';
SHOW GRANTS FOR '$backup_user'@'%';
SQL
routines="$(sql "$db" "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()")"
if [ "$routines" != 0 ]; then
  printf 'WARNING: %s holds %s stored routine(s); %s cannot be granted SHOW_ROUTINE on Azure, so the dumps leave them out\n' "$db" "$routines" "$backup_user" >&2
fi
tables="$(sql "$db" "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")"
step "Users converged: $app_user (ALL on $db), $backup_user (dump privileges on $db); $db holds $tables table(s)"
