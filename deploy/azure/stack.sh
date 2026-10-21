#!/usr/bin/env bash
# The compose-level deploy steps of the Azure target (deploy/azure/compose.yml
# over docker-compose.prod.yml): what the VM's bootstrap and an operator run,
# in the order the release needs. Every command is safe to repeat.
#
#   deploy/azure/stack.sh [--env-file PATH] <command> [args]
#
#   up        pull the images, converge the database users as the server
#             admin (db-init), take a dump first when the database already
#             has tables, run the migrations (`run --rm migrate`), the four
#             checks below, then start everything else and wait until healthy
#   check     the four post-migrate checks alone: `prisma migrate status` up
#             to date; `prisma migrate diff` of the live schema against
#             prisma/schema.prisma empty; SHOW TRIGGERS lists both ledger
#             triggers; an UPDATE of LedgerTransaction fails with "Ledger
#             records are strictly immutable"
#   drill     the three restore drills in the drill container (built on first
#             use), as the server admin: database backup + restore (--pitr
#             skip: point in time is Azure's), the documents archive, the
#             encrypted off-site round trip (to a sibling of OFFSITE_REMOTE,
#             <remote>-drill/<stamp>, removed after; DRILL_OFFSITE_REMOTE
#             overrides it, local:/tmp/... without OFFSITE_REMOTE). Run it in
#             a quiet hour: a write during the database drill makes its row
#             counts differ and it fails.
#   status    every backup job's last success (db-ops status)
#   ops ARGS  one-shot `db-ops ARGS` with the backup volume, e.g.
#             `ops offsite list`, `ops offsite check`, `ops backup --label before-change`
#
# The env file (default $DUKAANAI_ENV_FILE, else /etc/dukaanai/dukaanai.env;
# never in git; template: the root .env.example, "Azure target") holds every
# variable the compose files read. COMPOSE_FILE (the env file's, else the
# environment's) and COMPOSE_PROJECT_NAME in it are honoured (default:
# docker-compose.prod.yml:deploy/azure/compose.yml, project dukaanai-prod).
# STACK_PULL=0 skips the image pull (images built locally).
# shellcheck disable=SC2016  # single-quoted commands expand inside the containers
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${DUKAANAI_ENV_FILE:-/etc/dukaanai/dukaanai.env}"
if [ "${1:-}" = "--env-file" ]; then ENV_FILE="${2:?--env-file needs a path}"; shift 2; fi
CMD="${1:-}"; shift || true

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$CMD" ] || { sed -n '2,33p' "$0"; exit 2; }
case "$CMD" in -h|--help) sed -n '2,33p' "$0"; exit 0 ;; esac
[ -r "$ENV_FILE" ] || die "env file not readable: $ENV_FILE (pass --env-file PATH or set DUKAANAI_ENV_FILE)"

# A value of the env file as written (the last assignment wins, as in
# compose; surrounding quotes dropped). Empty when unset.
env_get() {
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
compose_files="$(env_get COMPOSE_FILE)"
compose_files="${compose_files:-${COMPOSE_FILE:-docker-compose.prod.yml:deploy/azure/compose.yml}}"
COMPOSE=("${DC[@]}" --project-directory "$REPO" --env-file "$ENV_FILE")
IFS=':' read -r -a files <<<"$compose_files"
for f in "${files[@]}"; do
  case "$f" in /*) COMPOSE+=(-f "$f") ;; *) COMPOSE+=(-f "$REPO/$f") ;; esac
done
project="$(env_get COMPOSE_PROJECT_NAME)"
[ -z "$project" ] || COMPOSE+=(-p "$project")
compose() { "${COMPOSE[@]}" "$@"; }

# Refuses an env file that would start what this VM cannot hold, or point the
# API at a Redis other than the one the overlay creates (a mismatch surfaces
# as an API that never turns healthy).
preflight() {
  local value
  value="$(env_get COMPOSE_PROFILES)"
  case ",$value,${COMPOSE_PROFILES:-}," in *,ops,*|*,\*,*) die "COMPOSE_PROFILES must not enable 'ops': the monitoring stack does not fit this VM's 1 GiB" ;; esac
  value="$(env_get REDIS_PASSWORD)"
  [ "${#value}" -ge 32 ] || die "REDIS_PASSWORD must be at least 32 characters (openssl rand -hex 32) in $ENV_FILE"
  case "$value" in *[!A-Za-z0-9._~-]*) die "REDIS_PASSWORD may only hold letters, digits and ._~- (it goes into REDIS_URL unescaped)" ;; esac
  case "$(env_get REDIS_URL)" in
    "redis://:$value@redis:6379"|"redis://:$value@redis:6379/"*) ;;
    *) die "REDIS_URL must be redis://:<REDIS_PASSWORD>@redis:6379/0 on this target (the Redis of deploy/azure/compose.yml)" ;;
  esac
  for value in DATABASE_URL DB_OPS_DATABASE_URL; do
    case "$(env_get "$value")" in
      *sslaccept=strict*sslcert=/etc/dukaanai/db-ca.pem*|*sslcert=/etc/dukaanai/db-ca.pem*sslaccept=strict*) ;;
      *) die "$value must carry ?sslaccept=strict&sslcert=/etc/dukaanai/db-ca.pem (Azure MySQL only over verified TLS)" ;;
    esac
  done
  value="$(env_get DB_CA_FILE)"
  [ -n "$value" ] && [ -r "$value" ] || die "DB_CA_FILE ($value) is not a readable file: the Azure CA bundle (deploy/azure/azure-mysql-ca.pem)"
}

# SQL on stdin as the backup user (SELECT and TRIGGER on the database), in a
# db-ops container; prints the rows.
backup_sql() {
  compose run --rm --no-deps -T --entrypoint bash db-ops -c '. /scripts/db/lib.sh; load_connection; sql "$DB_NAME"'
}

prisma() {
  compose run --rm --no-deps -T migrate /app/node_modules/.bin/prisma "$@"
}

check() {
  local out rc triggers
  step "check 1/4: prisma migrate status (every migration applied, nothing pending)"
  out="$(prisma migrate status 2>&1)" && rc=0 || rc=$?
  printf '%s\n' "$out" | tail -n 3
  if [ "$rc" != 0 ] || ! grep -q "Database schema is up to date" <<<"$out"; then
    die "migrate status: the database has pending or unknown migrations"
  fi

  step "check 2/4: prisma migrate diff, live schema == prisma/schema.prisma"
  # --from-schema-datasource takes the URL from DATABASE_URL in the
  # container's environment, never from an argument (`ps`).
  prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code \
    || die "migrate diff: the live schema differs from prisma/schema.prisma"

  step "check 3/4: SHOW TRIGGERS lists both ledger triggers"
  triggers="$(backup_sql <<<"SHOW TRIGGERS WHERE \`Table\` = 'LedgerTransaction'" | awk '{ print $1 }' | sort | tr '\n' ' ')"
  printf '  %s\n' "$triggers"
  [ "$triggers" = "prevent_ledger_delete prevent_ledger_update " ] || die "the ledger triggers are not both there (got: ${triggers:-none})"

  step "check 4/4: an UPDATE of LedgerTransaction is refused"
  # As the application user, through the release image's Prisma CLI: a row
  # inserted inside a transaction that never commits (foreign keys off for
  # this session only), so the trigger has a row to fire on even in an empty
  # database; the refused UPDATE ends the script and the insert rolls back.
  # Enum columns take their first member by index.
  out="$(compose run --rm --no-deps -T migrate /app/node_modules/.bin/prisma db execute --stdin --schema prisma/schema.prisma 2>&1 <<'SQL'
SET SESSION foreign_key_checks = 0;
START TRANSACTION;
INSERT INTO `LedgerTransaction` (`id`, `shopId`, `account`, `type`, `amount`, `balanceAfter`, `createdAt`) VALUES ('stack-check', 'stack-check', 1, 1, 0, 0, UTC_TIMESTAMP(3));
UPDATE `LedgerTransaction` SET `amount` = 1 WHERE `id` = 'stack-check';
ROLLBACK;
SQL
)" && rc=0 || rc=$?
  printf '  %s\n' "$(grep -m1 -i 'error' <<<"$out" || printf '%s' "$out")"
  if [ "$rc" = 0 ] || ! grep -q "Ledger records are strictly immutable" <<<"$out"; then
    die "an UPDATE of LedgerTransaction was not refused by the immutability trigger"
  fi
  step "All four post-migrate checks passed"
}

up() {
  local tables tag
  preflight
  if [ "${STACK_PULL:-1}" != 0 ]; then
    step "Pulling the images"
    compose pull --quiet
  fi
  step "Database users converged by the server admin (db-init)"
  compose run --rm db-init
  tables="$(backup_sql <<<"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")"
  if [ "${tables:-0}" -gt 0 ]; then
    tag="$(env_get IMAGE_TAG | tr -c 'A-Za-z0-9._-' '-')"
    step "Backup before migrating ($tables tables in the database)"
    compose run --rm db-ops backup --label "pre-migrate-${tag:-release}"
  else
    step "Empty database: no backup before the first migration"
  fi
  step "Release step: prisma migrate deploy"
  compose run --rm migrate
  check
  step "Everything else up and healthy"
  compose up -d --wait --remove-orphans
  compose ps
}

drill() {
  local failed=() stamp remote started name
  preflight
  step "Drill image (deploy/azure/drill.Dockerfile)"
  compose --profile drill build drill
  run_drill() {
    name="$1"; shift
    started="$(date +%s)"
    step "Drill: $name"
    if compose run --rm "$@"; then
      printf '\n%s drill: PASSED in %ss\n' "$name" "$(( $(date +%s) - started ))"
    else
      printf '\n%s drill: FAILED after %ss\n' "$name" "$(( $(date +%s) - started ))" >&2
      failed+=("$name")
    fi
  }
  # The admin's URL is built inside the container, its credentials
  # percent-encoded (an Azure admin password holds symbols) and never an argument.
  local as_admin='export DATABASE_URL="mysql://$(node -p "encodeURIComponent(process.env.AZURE_MYSQL_ADMIN_USER)"):$(node -p "encodeURIComponent(process.env.AZURE_MYSQL_ADMIN_PASSWORD)")@$AZURE_MYSQL_HOST:3306/$MYSQL_DATABASE?sslaccept=strict&sslcert=/etc/dukaanai/db-ca.pem"; [ -d "$MEDIA_DIR" ] || unset MEDIA_DIR;'
  run_drill database drill bash -c "$as_admin"' exec bash scripts/db/restore-drill.sh --pitr skip'
  run_drill documents drill bash -c "$as_admin"' exec bash scripts/storage/restore-drill.sh'
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  remote="$(env_get DRILL_OFFSITE_REMOTE)"
  if [ -z "$remote" ]; then
    remote="$(env_get OFFSITE_REMOTE)"
    if [ -n "$remote" ]; then remote="${remote%/}-drill/$stamp"; else remote="local:/tmp/offsite-drill-$stamp"; fi
  fi
  run_drill off-site -e OFFSITE_REMOTE="$remote" drill bash -c "$as_admin"' exec bash scripts/backup/offsite-drill.sh'
  case "$remote" in
    local:*) ;;
    *) step "Removing the drill's encrypted copy at $remote"
       compose run --rm drill rclone purge "$remote" || printf 'WARNING: could not remove %s; delete it by hand\n' "$remote" >&2 ;;
  esac
  [ "${#failed[@]}" -eq 0 ] || die "drill(s) failed: ${failed[*]}"
  step "All three drills passed"
}

case "$CMD" in
  up) up ;;
  check) check ;;
  drill) drill ;;
  status) compose run --rm db-ops status ;;
  ops) [ $# -gt 0 ] || die "ops needs db-ops arguments (e.g. ops offsite list)"; compose run --rm db-ops "$@" ;;
  *) die "unknown command: $CMD (up | check | drill | status | ops ARGS)" ;;
esac
