#!/usr/bin/env bash
# End-to-end test of the Azure target on any Docker host (amd64 or arm64):
# docker-compose.prod.yml + deploy/azure/compose.yml brought up by
# deploy/azure/stack.sh exactly as the VM's bootstrap does, against stand-ins
# for the two Azure services (deploy/azure/e2e/compose.e2e.yml): a MySQL
# 8.4.11 configured as the Bicep deployment configures Azure Database for
# MySQL Flexible Server B1ms (TLS only, a throwaway CA, the server
# parameters, Azure's admin privileges) and an S3 endpoint in place of
# Backblaze B2. It proves:
#   a  stack.sh up from an empty server: users created by the admin, the
#      app healthy through the edge, register + sign-in + a sale over HTTPS
#   b  the four post-migrate checks (stack.sh check)
#   c  Redis unreachable from web and edge, no published port but the edge,
#      no monitoring container
#   d  a product photo uploaded and read back byte for byte
#   e  the hourly dump and the incremental push land in the bucket
#      encrypted, and a full `offsite check` passes
#   f  disaster restore: fetch from the bucket into a clean directory,
#      verify the sidecars, restore the newest dump into a fresh MySQL 8.4,
#      every table's row count and CHECKSUM TABLE equal to the source at
#      dump time, the documents archive restored with the photo's SHA-256
#   g  memory under the overlay's limits while traffic, uploads and backups
#      run: peak per container, the total against 1 GiB + 2 GiB swap, and
#      no OOM kill
#   h  stop / start: healthy again; stack.sh up again (idempotent)
#   i  stack.sh drill (E2E_DRILL=0 skips it)
# Prints a PASS/FAIL table and exits non-zero on any failure; tears
# everything down (KEEP=1 leaves the stack and the work directory).
#
#   bash deploy/azure/e2e.sh
#
# Environment:
#   E2E_BUILD            images to build from this checkout (default "api web db-ops"); an
#                        image not listed must exist as <E2E_IMAGE_REGISTRY>/dukaanai-<name>:<E2E_IMAGE_TAG>
#   E2E_IMAGE_REGISTRY   default dukaanai-e2e;  E2E_IMAGE_TAG  default e2e
#   E2E_HTTP_PORT / E2E_HTTPS_PORT   the edge's host ports (default 18080 / 18443)
#   E2E_LOAD_SECONDS     length of the memory load (default 180)
#   E2E_WORK_DIR         work directory (default a new temporary one; it must be
#                        bind-mountable by the Docker daemon, e.g. under /Users on colima)
#   E2E_DRILL            1 (default) runs stack.sh drill
# Needs docker with compose 2.24.4+ (plugin or docker-compose), node 22+,
# openssl and curl. app.localhost / api.localhost must resolve to this machine.
# shellcheck disable=SC2016  # single-quoted commands expand inside the containers
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"
# *.localhost may resolve to ::1 first; the edge is published on 127.0.0.1.
export NODE_OPTIONS=--dns-result-order=ipv4first

KEEP="${KEEP:-0}"
REGISTRY="${E2E_IMAGE_REGISTRY:-dukaanai-e2e}"
TAG="${E2E_IMAGE_TAG:-e2e}"
BUILD="${E2E_BUILD:-api web db-ops}"
HTTP_PORT="${E2E_HTTP_PORT:-18080}"
HTTPS_PORT="${E2E_HTTPS_PORT:-18443}"
LOAD_SECONDS="${E2E_LOAD_SECONDS:-180}"
DRILL="${E2E_DRILL:-1}"
PROJECT=dukaanai-azure-e2e
WEB_HOST=app.localhost
API_HOST=api.localhost
WEB="https://${WEB_HOST}:${HTTPS_PORT}"
API="https://${API_HOST}:${HTTPS_PORT}/api"
MYSQL_HOST_NAME=dukaanai-e2e.mysql.database.azure.com
BUCKET=e2e-bucket
OWN_WORK=0
if [ -n "${E2E_WORK_DIR:-}" ]; then WORK="$E2E_WORK_DIR"; mkdir -p "$WORK"; else WORK="$(mktemp -d)"; OWN_WORK=1; fi
WORK="$(cd "$WORK" && pwd)"
ENV_FILE="$WORK/azure.env"
DB_OPS_IMAGE="$REGISTRY/dukaanai-db-ops:$TAG"
API_IMAGE="$REGISTRY/dukaanai-api:$TAG"
RESTORE_MYSQL="${PROJECT}-restore-mysql"
RESTORE_NET="${PROJECT}-restore"
NET="${PROJECT}_default"

if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
dc() { "${DC[@]}" --project-directory "$REPO" -p "$PROJECT" --env-file "$ENV_FILE" \
  -f docker-compose.prod.yml -f deploy/azure/compose.yml -f deploy/azure/e2e/compose.e2e.yml "$@"; }
stack() { STACK_PULL=0 bash deploy/azure/stack.sh --env-file "$ENV_FILE" "$@"; }

say() { printf '\n==> %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
gen() { openssl rand -hex "${1:-32}"; }
mib() { awk -v b="$1" 'BEGIN { printf "%.0f", b / 1048576 }'; }

RESULTS=()
FAILED=0
record() { RESULTS+=("$1|$2|$3|$4"); [ "$2" = PASS ] || [ "$2" = SKIP ] || FAILED=$((FAILED + 1)); }
# run_step ID TITLE FUNCTION [fatal]: a failing fatal step skips the rest.
STOPPED=""
run_step() {
  local id="$1" title="$2" fn="$3" fatal="${4:-}" started out rc
  if [ -n "$STOPPED" ]; then record "$id $title" SKIP "after $STOPPED failed" 0; return; fi
  started="$(date +%s)"
  printf '\n######## %s %s\n' "$id" "$title"
  set +e
  ( set -e; "$fn" ); rc=$?
  set -e
  out="$(cat "$WORK/detail" 2>/dev/null || true)"; rm -f "$WORK/detail"
  if [ "$rc" = 0 ]; then record "$id $title" PASS "$out" "$(( $(date +%s) - started ))"
  else
    record "$id $title" FAIL "${out:-exit $rc}" "$(( $(date +%s) - started ))"
    [ -z "$fatal" ] || STOPPED="$id"
  fi
}
detail() { printf '%s' "$*" > "$WORK/detail"; }
fail() { printf '\nSTEP FAILED: %s\n' "$*" >&2; detail "$*"; exit 1; }

print_table() {
  local row id status text secs
  printf '\n%-40s %-5s %6s  %s\n' "STEP" "RESULT" "TIME" "DETAIL"
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r id status text secs <<<"$row"
    printf '%-40s %-5s %5ss  %s\n' "$id" "$status" "$secs" "$text"
  done
}

cleanup() {
  touch "$WORK/sampler.stop" 2>/dev/null || true
  [ ! -f "$WORK/load.pids" ] || xargs kill < "$WORK/load.pids" 2>/dev/null || true
  print_table || true
  if [ "$KEEP" = 1 ]; then printf '\nKEEP=1: stack %s left running; work directory %s\n' "$PROJECT" "$WORK"; return; fi
  say "teardown (project $PROJECT)"
  docker rm -f "$RESTORE_MYSQL" "${PROJECT}-sampler" >/dev/null 2>&1 || true
  docker network rm "$RESTORE_NET" >/dev/null 2>&1 || true
  [ ! -f "$ENV_FILE" ] || dc --profile '*' down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$OWN_WORK" = 0 ] || rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------- prepare

prepare() {
  local v name df
  for v in docker node openssl curl; do command -v "$v" >/dev/null || fail "$v is required"; done
  v="$("${DC[@]}" version --short 2>/dev/null | sed 's/^v//')"
  [ "$(printf '%s\n%s\n' 2.24.4 "$v" | sort -V | head -n 1)" = 2.24.4 ] || fail "Docker Compose $v is too old (2.24.4+)"
  for name in "$WEB_HOST" "$API_HOST"; do
    node -e "require('dns').lookup('$name', (e, a) => process.exit(!e && ['127.0.0.1', '::1'].includes(a) ? 0 : 1))" \
      || fail "$name does not resolve to this machine (add 127.0.0.1 $name to /etc/hosts)"
  done
  for name in $BUILD; do
    case "$name" in
      api) df=apps/api/Dockerfile ;;
      web) df=apps/web/Dockerfile ;;
      db-ops) df=deploy/db-ops/Dockerfile ;;
      *) fail "E2E_BUILD: unknown image $name" ;;
    esac
    say "building $REGISTRY/dukaanai-$name:$TAG ($df)"
    if docker buildx version >/dev/null 2>&1; then
      docker build -q -f "$df" --build-arg APP_RELEASE=e2e -t "$REGISTRY/dukaanai-$name:$TAG" . >/dev/null
    else
      DOCKER_BUILDKIT=0 docker build -q -f "$df" --build-arg APP_RELEASE=e2e -t "$REGISTRY/dukaanai-$name:$TAG" . >/dev/null
    fi
  done
  for name in api web db-ops; do
    docker image inspect "$REGISTRY/dukaanai-$name:$TAG" >/dev/null 2>&1 || fail "image $REGISTRY/dukaanai-$name:$TAG missing (add it to E2E_BUILD)"
    note "$name: $(docker image inspect -f '{{.Architecture}} {{.Id}}' "$REGISTRY/dukaanai-$name:$TAG" | cut -c1-30)"
  done

  say "throwaway CA and the server certificate of $MYSQL_HOST_NAME"
  mkdir -p "$WORK/certs" "$WORK/restore"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -subj "/CN=DukaanAI Azure e2e CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$WORK/certs/ca.key" -out "$WORK/certs/ca.pem" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=$MYSQL_HOST_NAME" \
    -keyout "$WORK/certs/server.key" -out "$WORK/certs/server.csr" >/dev/null 2>&1
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$MYSQL_HOST_NAME" > "$WORK/certs/server.ext"
  openssl x509 -req -sha256 -days 2 -in "$WORK/certs/server.csr" -CA "$WORK/certs/ca.pem" -CAkey "$WORK/certs/ca.key" \
    -CAcreateserial -extfile "$WORK/certs/server.ext" -out "$WORK/certs/server.pem" >/dev/null 2>&1
  # The committed Azure bundle with the throwaway CA appended: the clients
  # read a multi-certificate file with comment lines, as on the VM.
  cat deploy/azure/azure-mysql-ca.pem "$WORK/certs/ca.pem" > "$WORK/certs/db-ca.pem"
  chmod 755 "$WORK" "$WORK/certs"; chmod 644 "$WORK"/certs/*; chmod 777 "$WORK/restore"

  say "the operator's env file, with the names deploy/azure/bootstrap.sh writes"
  local app_pw backup_pw redis_pw admin_pw
  app_pw="$(gen)"; backup_pw="$(gen)"; redis_pw="$(gen)"
  # An Azure admin password holds symbols: the drills must encode it.
  admin_pw="Az1!@:/?%+=$(gen 12)"
  cat > "$ENV_FILE" <<ENV
COMPOSE_FILE=docker-compose.prod.yml:deploy/azure/compose.yml:deploy/azure/e2e/compose.e2e.yml
COMPOSE_PROJECT_NAME=$PROJECT
IMAGE_REGISTRY=$REGISTRY
IMAGE_TAG=$TAG
WEB_HOST=$WEB_HOST
API_HOST=$API_HOST
WEB_ORIGIN=$WEB
API_PUBLIC_URL=$API
EDGE_TLS_LINE=tls internal
EDGE_HTTP_PORT=$HTTP_PORT
EDGE_HTTPS_PORT=$HTTPS_PORT
TRUST_PROXY=1
JWT_SECRET=$(gen)
NEXTAUTH_SECRET=$(gen)
METRICS_TOKEN=$(gen)
GRAFANA_ADMIN_PASSWORD=$(gen 24)
AZURE_MYSQL_HOST=$MYSQL_HOST_NAME
AZURE_MYSQL_ADMIN_USER=dukaanaiadmin
AZURE_MYSQL_ADMIN_PASSWORD=$admin_pw
MYSQL_DATABASE=dukaanai
MYSQL_USER=dukaanai
MYSQL_PASSWORD=$app_pw
MYSQL_BACKUP_PASSWORD=$backup_pw
DB_CA_FILE=$WORK/certs/db-ca.pem
DATABASE_URL=mysql://dukaanai:$app_pw@$MYSQL_HOST_NAME:3306/dukaanai?connection_limit=20&sslaccept=strict&sslcert=/etc/dukaanai/db-ca.pem
DB_OPS_DATABASE_URL=mysql://dukaanai_backup:$backup_pw@$MYSQL_HOST_NAME:3306/dukaanai?sslaccept=strict&sslcert=/etc/dukaanai/db-ca.pem
REDIS_PASSWORD=$redis_pw
REDIS_URL=redis://:$redis_pw@redis:6379/0
OFFSITE_REMOTE=b2:$BUCKET/prod
OFFSITE_CRYPT_PASSWORD=$(gen)
OFFSITE_CRYPT_SALT=$(gen)
OFFSITE_KEEP_DAYS=30
RCLONE_CONFIG_B2_TYPE=s3
RCLONE_CONFIG_B2_PROVIDER=Other
RCLONE_CONFIG_B2_ENDPOINT=http://fake-b2:9000
RCLONE_CONFIG_B2_REGION=us-east-005
RCLONE_CONFIG_B2_NO_CHECK_BUCKET=true
RCLONE_CONFIG_B2_ACCESS_KEY_ID=$(gen 12)
RCLONE_CONFIG_B2_SECRET_ACCESS_KEY=$(gen 20)
BACKUP_LOOP_HOURLY_SECONDS=60
BACKUP_LOOP_INITIAL_DELAY_SECONDS=5
E2E_MYSQL_ROOT_PASSWORD=$(gen)
E2E_CERT_DIR=$WORK/certs
E2E_B2_BUCKET=$BUCKET
ENV
  chmod 600 "$ENV_FILE"
  dc config -q

  say "a real phone-sized JPEG (2048 x 1536, made with sharp from the API image)"
  docker run --rm --user "$(id -u):$(id -g)" -v "$WORK:/out" --entrypoint node "$API_IMAGE" -e \
    "require('sharp')({ create: { width: 2048, height: 1536, channels: 3, background: { r: 200, g: 120, b: 40 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 85 }).toFile('/out/photo.jpg').then((i) => console.log(i.size + ' bytes'))"
  [ "$(head -c 3 "$WORK/photo.jpg" | od -An -tx1 | tr -d ' \n')" = ffd8ff ] || fail "photo.jpg is not a JPEG"
  detail "images $(echo "$BUILD" | tr ' ' ','), certificates, env file, photo $(wc -c < "$WORK/photo.jpg" | tr -d ' ') bytes"
}

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
# One-shot db-ops container on the stack's network, with an env file (never
# a password in an argument).
dbops() { docker run --rm --network "$NET" --user 1000:1000 -e HOME=/tmp "$@"; }
admin_env() {
  cat > "$WORK/admin.env" <<ENV
MYSQL_HOST=$MYSQL_HOST_NAME
MYSQL_USER=$(env_get AZURE_MYSQL_ADMIN_USER)
MYSQL_PASSWORD=$(env_get AZURE_MYSQL_ADMIN_PASSWORD)
MYSQL_DATABASE=dukaanai
MYSQL_SSL_MODE=verify
MYSQL_SSL_CA=/ca.pem
ENV
  chmod 644 "$WORK/admin.env"
}
offsite_env() {
  { grep -E '^(OFFSITE_|RCLONE_CONFIG_B2_)' "$ENV_FILE"; } > "$WORK/offsite.env"
  chmod 644 "$WORK/offsite.env"
}
# SQL on stdin against the Azure-like server as its admin.
admin_sql() {
  dbops -i --env-file "$WORK/admin.env" -v "$WORK/certs/db-ca.pem:/ca.pem:ro" --entrypoint bash "$DB_OPS_IMAGE" \
    -c '. /scripts/db/lib.sh; load_connection; sql "$DB_NAME"'
}
wait_healthy() {
  local deadline=$(( $(date +%s) + $1 )) svc state all
  shift
  while [ "$(date +%s)" -lt "$deadline" ]; do
    all=1
    for svc in "$@"; do
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-${svc}-1" 2>/dev/null || echo missing)"
      [ "$state" = healthy ] || all=0
    done
    [ "$all" = 1 ] && return 0
    sleep 2
  done
  return 1
}
# Steps run in subshells: what one hands the next lives in WORK.
edge_ca() {
  for _ in $(seq 1 30); do dc cp edge:/data/caddy/pki/authorities/local/root.crt "$WORK/caddy-root.crt" >/dev/null 2>&1 && break; sleep 1; done
  [ -s "$WORK/caddy-root.crt" ]
}
curl_edge() { curl -sS --cacert "$WORK/caddy-root.crt" --resolve "${WEB_HOST}:${HTTPS_PORT}:127.0.0.1" --resolve "${API_HOST}:${HTTPS_PORT}:127.0.0.1" "$@"; }
snapshot() { docker run --rm -i --user 1000:1000 -e HOME=/tmp -v "$REPO/deploy/azure/e2e/table-snapshot.sh:/snapshot.sh:ro" "$@" --entrypoint bash "$DB_OPS_IMAGE" /snapshot.sh; }

# ---------------------------------------------------------------- steps

step_up() {
  local out ready flow vars grants
  out="$(stack up 2>&1)" || { printf '%s\n' "$out"; fail "stack.sh up failed"; }
  printf '%s\n' "$out"
  grep -q "Empty database: no backup before the first migration" <<<"$out" || fail "the first up did not see an empty database"
  grep -q "Users converged" <<<"$out" || fail "db-init did not converge the users"
  admin_env; offsite_env
  vars="$(admin_sql <<<"SELECT CONCAT_WS(' ', @@version, @@lower_case_table_names, @@require_secure_transport, @@time_zone, @@character_set_server, @@collation_server, @@log_bin_trust_function_creators, @@sql_generate_invisible_primary_key, @@max_connections)")"
  note "server: version lctn require_secure_transport time_zone charset collation trust_creators gipk max_connections = $vars"
  grants="$(admin_sql <<<"SHOW GRANTS FOR 'dukaanai_backup'@'%'" | tr '\n' ';')"
  note "backup user: $grants"
  grep -qF 'GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON `dukaanai`.* TO `dukaanai_backup`@`%`' <<<"$grants" || fail "dukaanai_backup grants: $grants"
  grep -q 'GRANT USAGE ON \*\.\*' <<<"$grants" || fail "dukaanai_backup holds a global privilege: $grants"
  edge_ca || fail "no Caddy root certificate"
  ready="$(curl_edge -o /dev/null -w '%{http_code}' "$API/health/ready")"
  [ "$ready" = 200 ] || fail "readiness through the edge answered $ready"
  flow="$(NODE_EXTRA_CA_CERTS="$WORK/caddy-root.crt" SMOKE_API_URL="$API" SMOKE_WEB_URL="$WEB" node scripts/smoke-flow.mjs 2>&1)" || { printf '%s\n' "$flow"; fail "smoke flow through the edge"; }
  printf '%s\n' "$flow"
  grep -q "SMOKE FLOW PASSED" <<<"$flow" || fail "the smoke flow printed no pass line"
  detail "users by the admin; readiness 200 via edge; register, API + web sign-in, sale, reconciliation CLEAN over HTTPS; server: $vars"
}

step_check() {
  local out
  out="$(stack check 2>&1)" || { printf '%s\n' "$out"; fail "stack.sh check failed"; }
  printf '%s\n' "$out"
  grep -q "All four post-migrate checks passed" <<<"$out" || fail "no pass line"
  detail "migrate status up to date, migrate diff empty, both ledger triggers, UPDATE refused"
}

step_isolation() {
  local ports published web edge api auth argv monitoring
  ports="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}} {{.Ports}}')"
  printf '%s\n' "$ports"
  published="$(grep -- '->' <<<"$ports" | cut -d' ' -f1 | sort -u | tr '\n' ' ')"
  [ "$published" = "edge " ] || fail "published ports on: $published"
  web="$(dc exec -T web node -e "require('dns').lookup('redis', (e) => console.log(e ? e.code : 'RESOLVED'))" 2>&1 | tail -n 1)"
  # Docker's DNS forwards a name it does not hold to the host's resolver,
  # which answers ENOTFOUND or, on some hosts, EAI_AGAIN: both mean unresolved.
  case "$web" in ENOTFOUND|EAI_AGAIN) ;; *) fail "web resolves redis ($web)" ;; esac
  edge="$(dc exec -T edge sh -c 'if nslookup redis >/dev/null 2>&1; then echo RESOLVED; else echo unresolved; fi' 2>&1 | tail -n 1)"
  [ "$edge" = unresolved ] || fail "edge resolves redis ($edge)"
  api="$(dc exec -T api node -e "require('net').connect(6379, 'redis').on('connect', function () { console.log('CONNECTED'); this.end(); }).on('error', (e) => console.log(e.code))" 2>&1 | tail -n 1)"
  [ "$api" = CONNECTED ] || fail "api cannot reach redis ($api)"
  # Unset, not blank: a blank REDISCLI_AUTH still sends AUTH "" and fails
  # there, never reaching the PING this check is about.
  auth="$(dc exec -T redis sh -c 'unset REDISCLI_AUTH; exec redis-cli ping' 2>&1 || true)"
  grep -q NOAUTH <<<"$auth" || fail "redis answers without the password ($auth)"
  argv="$(docker top "${PROJECT}-redis-1")"
  if grep -qF "$(env_get REDIS_PASSWORD)" <<<"$argv"; then fail "the Redis password is in a process argument"; fi
  monitoring="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}}' | grep -E '^(prometheus|alertmanager|grafana|loki|alloy|blackbox)$' || true)"
  [ -z "$monitoring" ] || fail "monitoring containers running: $monitoring"
  detail "only edge publishes; web: redis $web; edge: unresolved; api: connected; NOAUTH without password; password not in argv; no monitoring container"
}

step_upload() {
  local out
  sleep 10 # the smoke flow's sign-ins and these two share the per-address auth window
  local photo_sha
  out="$(NODE_EXTRA_CA_CERTS="$WORK/caddy-root.crt" E2E_API_URL="$API" node deploy/azure/e2e/upload.mjs "$WORK/photo.jpg" 2>&1)" || { printf '%s\n' "$out"; fail "upload round trip"; }
  printf '%s\n' "$out"
  photo_sha="$(sed -n 's/.*"sha256Received":"\([0-9a-f]*\)".*/\1/p' <<<"$out" | tail -n 1)"
  [ "$photo_sha" = "$(openssl dgst -sha256 -r "$WORK/photo.jpg" | cut -d' ' -f1)" ] || fail "sha256 differs"
  printf '%s\n' "$photo_sha" > "$WORK/photo.sha256"
  detail "POST /api/media/upload/product/:id + GET /api/media/assets/:id/file through the edge: sha256 ${photo_sha:0:16}... equal"
}

step_backups() {
  local since out logs incremental listing raw header
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  out="$(stack ops documents-backup 2>&1)" || { printf '%s\n' "$out"; fail "documents-backup"; }
  printf '%s\n' "$out" | tail -n 3
  say "waiting for the backup agent's next hourly run (dump into /backups/hourly, incremental push)"
  incremental=""
  for _ in $(seq 1 90); do
    logs="$(dc logs --no-color --since "$since" backup-agent 2>/dev/null || true)"
    if grep -q 'Backup written: /backups/hourly/' <<<"$logs" && grep -q '==> Off-site copy complete' <<<"$logs"; then
      incremental="$(grep -o 'Off-site copy: .* new of [0-9]* file(s)' <<<"$logs" | tail -n 1)"
      [ -n "$incremental" ] && break
    fi
    sleep 2
  done
  printf '%s\n' "$logs" | grep -E '==> (Backup written|Off-site copy|Verifying|Pruning)' || true
  [ -n "$incremental" ] || fail "no hourly dump followed by an off-site push within 180 s"
  local new total
  new="$(sed -n 's/.*: \([0-9]*\) new of \([0-9]*\) file(s)/\1/p' <<<"$incremental")"
  total="$(sed -n 's/.*: \([0-9]*\) new of \([0-9]*\) file(s)/\2/p' <<<"$incremental")"
  note "last push: $new new of $total"
  [ "$new" -ge 1 ] && [ "$new" -lt "$total" ] || fail "the push was not incremental ($incremental)"
  listing="$(stack ops offsite list 2>&1)" || fail "offsite list"
  grep -Eq 'hourly/dukaanai-[0-9TZ]+\.sql\.gz$' <<<"$listing" || { printf '%s\n' "$listing"; fail "no hourly dump in the bucket"; }
  grep -Eq 'documents/documents-[0-9TZ]+\.tar\.gz$' <<<"$listing" || { printf '%s\n' "$listing"; fail "no documents archive in the bucket"; }
  out="$(stack ops offsite check 2>&1)" || { printf '%s\n' "$out"; fail "offsite check (full verification) failed"; }
  printf '%s\n' "$out" | grep '==>' || true
  raw="$(dc exec -T fake-b2 sh -c "cd /data/$BUCKET/prod && find . -type f" 2>/dev/null)"
  note "$(wc -l <<<"$raw" | tr -d ' ') objects under $BUCKET/prod"
  if grep -Eqi 'sql|tar|sha256|hourly|documents|status|dukaanai' <<<"$raw"; then fail "a readable name in the bucket"; fi
  header="$(dc exec -T fake-b2 sh -c "cd /data/$BUCKET/prod && head -c 8 \"\$(find . -type f | head -n 1)\"" 2>/dev/null | head -c 6)"
  [ "$header" = RCLONE ] || fail "the objects are not rclone crypt files (header '$header')"
  detail "hourly dump + push ($new new of $total, the rest confirmed); hourly dump and documents archive listed; full check passed; names and bytes encrypted"
}

step_memory() {
  local ids name id end lg_rc up_rc limits oom total_anon total_all daemons verdict a f s k
  ids=()
  for name in edge web api redis backup-agent; do ids+=("$name=$(docker inspect -f '{{.Id}}' "${PROJECT}-${name}-1")"); done
  rm -f "$WORK/sampler.stop" "$WORK/samples.txt"
  docker run -d --name "${PROJECT}-sampler" --pid=host -v /sys/fs/cgroup:/cg:ro -v "$WORK:/work" \
    -v "$REPO/deploy/azure/e2e/memory-sampler.sh:/sampler.sh:ro" --entrypoint bash "$DB_OPS_IMAGE" \
    /sampler.sh /work/samples.txt /work/sampler.stop 1 "${ids[@]}" >/dev/null
  say "load for ${LOAD_SECONDS}s: 2 shops x 3 terminals at the production rate limits (apps/api/load/limits-gate.mjs), a 2048 x 1536 photo every 10 s through the edge, the web's pages through the edge, the backup agent's run every 60 s"
  end=$(( $(date +%s) + LOAD_SECONDS ))
  ( while [ "$(date +%s)" -lt "$end" ]; do
      for path in /login /register /forgot-password /dashboard; do
        curl_edge -o /dev/null "$WEB$path" 2>/dev/null || true
      done
    done ) &
  echo "$!" > "$WORK/load.pids"
  ( while [ "$(date +%s)" -lt "$end" ]; do curl_edge -o /dev/null "$WEB/login" 2>/dev/null || true; done ) &
  echo "$!" >> "$WORK/load.pids"
  NODE_EXTRA_CA_CERTS="$WORK/caddy-root.crt" E2E_API_URL="$API" node deploy/azure/e2e/upload.mjs "$WORK/photo.jpg" \
    --repeat $(( LOAD_SECONDS / 10 )) --every 10 > "$WORK/upload-load.log" 2>&1 &
  local upload_pid=$!
  echo "$upload_pid" >> "$WORK/load.pids"
  lg_rc=0
  docker run --rm --network "$NET" -v "$REPO/apps/api/load:/load:ro" -e LOAD_TARGET=http://api:3002 \
    -e LIMITS_SHOPS=2 -e LIMITS_TERMINALS=3 -e LIMITS_DURATION_S="$LOAD_SECONDS" -e LIMITS_REPORT=/tmp/limits.json \
    --entrypoint node "$API_IMAGE" /load/limits-gate.mjs > "$WORK/limits-gate.log" 2>&1 || lg_rc=$?
  up_rc=0; wait "$upload_pid" || up_rc=$?
  wait 2>/dev/null || true; rm -f "$WORK/load.pids"
  touch "$WORK/sampler.stop"; sleep 2; docker rm -f "${PROJECT}-sampler" >/dev/null 2>&1 || true
  tail -n 12 "$WORK/limits-gate.log"
  note "uploads under load: $(grep -c '"round"' "$WORK/upload-load.log" || true) round trips, exit $up_rc"

  say "memory per container (MiB): peak anonymous (what swap or the OOM killer must deal with), peak anonymous + page cache, peak swap, the overlay's limit, OOM kills"
  total_anon=0; total_all=0; oom=0
  printf '%-14s %10s %12s %10s %10s %6s\n' container anon_peak anon+cache swap_peak mem_limit oom > "$WORK/memory.txt"
  for name in edge web api redis backup-agent; do
    id="${PROJECT}-${name}-1"
    read -r a f s <<<"$(awk -v n="$name" '$2 == n { if ($3 > a) a = $3; if ($3 + $4 > t) t = $3 + $4; if ($5 > s) s = $5 } END { print a + 0, t + 0, s + 0 }' "$WORK/samples.txt")"
    limits="$(docker inspect -f '{{.HostConfig.Memory}}' "$id")"
    k="$(docker run --rm -v /sys/fs/cgroup:/cg:ro --entrypoint sh "$DB_OPS_IMAGE" -c "cat /cg/system.slice/docker-$(docker inspect -f '{{.Id}}' "$id").scope/memory.events /cg/docker/$(docker inspect -f '{{.Id}}' "$id")/memory.events 2>/dev/null | awk '\$1 == \"oom_kill\" { print \$2 }' | head -n 1")"
    [ "$(docker inspect -f '{{.State.OOMKilled}}' "$id")" = false ] || k=$(( ${k:-0} + 1 ))
    oom=$(( oom + ${k:-0} ))
    total_anon=$(( total_anon + a )); total_all=$(( total_all + f ))
    printf '%-14s %10s %12s %10s %10s %6s\n' "$name" "$(mib "$a")" "$(mib "$f")" "$(mib "$s")" "$(mib "$limits")" "${k:-0}" >> "$WORK/memory.txt"
  done
  daemons="$(awk '$2 == "docker-daemons" { if ($3 > d) d = $3 } END { print d + 0 }' "$WORK/samples.txt")"
  printf '%-14s %10s\n' "docker daemons" "$(mib "$daemons")" >> "$WORK/memory.txt"
  printf '%-14s %10s %12s\n' "sum" "$(mib $(( total_anon + daemons )))" "$(mib $(( total_all + daemons )))" >> "$WORK/memory.txt"
  cat "$WORK/memory.txt"
  printf '%s %s %s %s\n' "$total_anon" "$total_all" "$daemons" "$oom" > "$WORK/memory.sum"
  verdict="peaks: containers $(mib "$total_anon") MiB anonymous ($(mib "$total_all") with cache) + docker daemons $(mib "$daemons") MiB; OOM kills $oom"
  [ "$lg_rc" = 0 ] || fail "limits-gate failed under load (exit $lg_rc); $verdict"
  [ "$up_rc" = 0 ] || fail "uploads under load failed; $verdict"
  [ "$oom" = 0 ] || fail "$verdict"
  [ $(( total_anon + daemons )) -lt $(( 3072 * 1048576 )) ] || fail "beyond 1 GiB RAM + 2 GiB swap: $verdict"
  detail "$verdict"
}

step_disaster() {
  local since logs dump docs found restored_photo photo_sha
  photo_sha="$(cat "$WORK/photo.sha256" 2>/dev/null || true)"
  [ -n "$photo_sha" ] || fail "no photo was uploaded (step d)"
  say "quiesce writes: stop edge, web and api; the backup agent's next run is the disaster backup"
  dc stop edge web api >/dev/null 2>&1
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # A dump begun before the stop would hold writes the source snapshot does
  # not: wait for one whose snapshot stamp is after it, then its push.
  local stamp="${since//[-:]/}" ok=""
  for _ in $(seq 1 90); do
    logs="$(dc logs --no-color --since "$since" backup-agent 2>/dev/null || true)"
    ok="$(awk -v s="$stamp" '
      /==> Backup written: / { d = substr($0, index($0, "dukaanai-") + 9, 16); fresh = (d >= s) }
      /==> Off-site copy complete/ && fresh { print "yes"; exit }' <<<"$logs")"
    [ "$ok" = yes ] && break
    sleep 2
  done
  [ "$ok" = yes ] || fail "no backup taken and pushed after the writes stopped (within 180 s)"
  say "the source at dump time: row count and CHECKSUM TABLE of every table (as the admin)"
  snapshot --network "$NET" --env-file "$WORK/admin.env" -v "$WORK/certs/db-ca.pem:/ca.pem:ro" > "$WORK/source.tables"
  note "$(wc -l < "$WORK/source.tables" | tr -d ' ') tables; $(awk '$1 ~ /^(invoice|ledgertransaction|mediaasset|product)$/' "$WORK/source.tables" | tr '\n' ';')"

  say "disaster: a clean directory fetches everything from the bucket, decrypted"
  rm -rf "$WORK/restore/set" "$WORK/restore/docs"
  dbops --env-file "$WORK/offsite.env" -v "$WORK/restore:/restore" "$DB_OPS_IMAGE" offsite fetch /restore/set
  # Everything fetched is owner-only (uid 1000): it is read in containers.
  found="$(dbops -v "$WORK/restore:/restore" --entrypoint bash "$DB_OPS_IMAGE" -c '
    set -euo pipefail; cd /restore/set; n=0
    for f in $(find . -name "*.sha256" ! -path "./status/*"); do (cd "$(dirname "$f")" && sha256sum -c --quiet "$(basename "$f")"); n=$((n + 1)); done
    echo "sidecars $n"
    echo "dump $(find . -maxdepth 2 -name "dukaanai-*.sql.gz" -printf "%f %P\n" | sort | tail -n 1 | cut -d" " -f2)"
    echo "docs $(find documents -name "documents-*.tar.gz" | sort | tail -n 1)"')" || fail "the fetched set does not verify"
  printf '%s\n' "$found"
  dump="$(sed -n 's/^dump //p' <<<"$found")"; docs="$(sed -n 's/^docs //p' <<<"$found")"
  [ -n "$dump" ] || fail "no dump fetched"
  [ -n "$docs" ] || fail "no documents archive fetched"

  say "a fresh MySQL 8.4.11 (as Azure would create it), the dump restored into it"
  docker network create "$RESTORE_NET" >/dev/null
  docker run -d --name "$RESTORE_MYSQL" --network "$RESTORE_NET" -e MYSQL_ROOT_PASSWORD=restore-root-pw mysql:8.4.11 \
    --lower-case-table-names=1 --log-bin-trust-function-creators=ON --character-set-server=utf8mb4 \
    --collation-server=utf8mb4_unicode_ci --default-time-zone=+00:00 --sql-generate-invisible-primary-key=ON >/dev/null
  for _ in $(seq 1 60); do docker exec "$RESTORE_MYSQL" mysqladmin ping -h127.0.0.1 --protocol=tcp -uroot -prestore-root-pw --silent >/dev/null 2>&1 && break; sleep 2; done
  printf 'DATABASE_URL=mysql://root:restore-root-pw@%s:3306/dukaanai\n' "$RESTORE_MYSQL" > "$WORK/restore.env"; chmod 644 "$WORK/restore.env"
  docker run --rm --network "$RESTORE_NET" --user 1000:1000 -e HOME=/tmp --env-file "$WORK/restore.env" -v "$WORK/restore:/restore" \
    "$DB_OPS_IMAGE" restore "/restore/set/$dump" --database dukaanai --create --yes
  snapshot --network "$RESTORE_NET" --env-file "$WORK/restore.env" > "$WORK/restored.tables"
  if ! diff "$WORK/source.tables" "$WORK/restored.tables" > "$WORK/tables.diff"; then
    cat "$WORK/tables.diff"; fail "restored tables differ from the source (row count or checksum)"
  fi
  awk '$1 == "invoice" && $2 > 0 { f = 1 } END { exit f ? 0 : 1 }' "$WORK/restored.tables" || fail "the restored copy holds no invoice"

  say "the documents archive restored; the photo's SHA-256"
  docker run --rm --user 1000:1000 -e HOME=/tmp -v "$WORK/restore:/restore" "$DB_OPS_IMAGE" \
    documents-restore "/restore/set/$docs" --to /restore/docs --yes
  restored_photo="$(docker run --rm --user 1000:1000 -v "$WORK/restore:/restore" --entrypoint bash "$DB_OPS_IMAGE" -c \
    "find /restore/docs -type f -name '$photo_sha.*' -exec sha256sum {} + | head -n 1")"
  note "restored: $restored_photo"
  [ "${restored_photo%% *}" = "$photo_sha" ] || fail "the photo is not in the restored documents, or its sha256 differs"

  say "back in service"
  dc up -d --wait api web edge >/dev/null 2>&1 || fail "api, web and edge did not come back"
  detail "$(wc -l < "$WORK/source.tables" | tr -d ' ') tables equal (rows + CHECKSUM TABLE) after fetch -> sidecars -> restore into a fresh MySQL 8.4.11; photo ${photo_sha:0:12}... restored byte for byte"
}

step_drill() {
  local out
  out="$(stack drill 2>&1)" || { printf '%s\n' "$out" | tail -n 80; fail "stack.sh drill failed"; }
  printf '%s\n' "$out" | grep -E 'drill: (PASSED|FAILED)|DRILL PASSED|All three' || true
  grep -q "All three drills passed" <<<"$out" || fail "no pass line"
  detail "$(grep -E 'drill: PASSED' <<<"$out" | tr '\n' ' ')"
}

step_restart() {
  local started healthy out
  dc stop -t 40 >/dev/null 2>&1
  [ -z "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" ] || fail "containers still running after stop"
  started="$(date +%s)"
  dc start >/dev/null 2>&1
  wait_healthy 240 redis api web edge || fail "not healthy within 240 s after start"
  healthy=$(( $(date +%s) - started ))
  [ "$(curl_edge -o /dev/null -w '%{http_code}' "$API/health/ready")" = 200 ] || fail "readiness after the restart"
  out="$(NODE_EXTRA_CA_CERTS="$WORK/caddy-root.crt" E2E_API_URL="$API" node deploy/azure/e2e/upload.mjs "$WORK/photo.jpg" 2>&1)" || { printf '%s\n' "$out"; fail "sign-in and upload after the restart"; }
  out="$(stack up 2>&1)" || { printf '%s\n' "$out"; fail "stack.sh up again"; }
  grep -q "Backup before migrating" <<<"$out" || fail "the second up took no pre-migrate backup"
  grep -q "No pending migrations to apply" <<<"$out" || fail "the second up found migrations to apply"
  detail "healthy ${healthy}s after start; register + login + upload OK; stack.sh up again: pre-migrate backup, nothing to migrate, checks passed"
}

started_all="$(date +%s)"
run_step prepare "images, certificates, env" prepare fatal
run_step a "up, flow through the edge" step_up fatal
run_step b "post-migrate checks" step_check
run_step c "isolation" step_isolation
run_step d "photo round trip" step_upload
run_step e "hourly dump + incremental push" step_backups
run_step g "memory under load" step_memory
run_step f "disaster restore" step_disaster
if [ "$DRILL" = 1 ]; then run_step i "restore drills" step_drill; else record "i restore drills" SKIP "E2E_DRILL=0" 0; fi
run_step h "stop / start, up again" step_restart
printf '\nTotal %ss\n' "$(( $(date +%s) - started_all ))"
[ -f "$WORK/memory.txt" ] && { printf '\nMemory (MiB):\n'; cat "$WORK/memory.txt"; }
if [ "$FAILED" -gt 0 ]; then printf '\nAZURE E2E FAILED: %s step(s)\n' "$FAILED"; exit 1; fi
printf '\nAZURE E2E PASSED\n'
