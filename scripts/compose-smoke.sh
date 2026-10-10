#!/usr/bin/env bash
# Phase 7 exit gate (roadmap 7.3): a fresh clone -> `docker compose up` ->
# migrations -> login -> a sale works from scratch, and the API stops
# gracefully. Needs docker (compose v2), curl and node. Run from any directory:
#
#   bash scripts/compose-smoke.sh            # builds, proves, tears down
#   KEEP=1 bash scripts/compose-smoke.sh     # leaves the stack running
#
# A missing .env is created from .env.example with generated secrets, exactly
# what a first-time operator does by hand.
#
# On release candidate images instead of a build (scripts/certify, roadmap
# 9.12): SMOKE_PREBUILT=1 never builds (the images must already be present
# or pullable under the names the compose files resolve to), SMOKE_ENV_FILE
# is the environment file handed to compose instead of ./.env (which is
# then neither read nor created), and COMPOSE_FILE (compose's own variable)
# adds the overlay that names the images.
set -euo pipefail
cd "$(dirname "$0")/.."

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-3002}"
API="http://127.0.0.1:${API_PORT}/api"
WEB="http://127.0.0.1:${WEB_PORT}"
KEEP="${KEEP:-0}"
PREBUILT="${SMOKE_PREBUILT:-0}"
COMPOSE=(docker compose)
if [ -n "${SMOKE_ENV_FILE:-}" ]; then COMPOSE+=(--env-file "$SMOKE_ENV_FILE"); fi
step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nSMOKE FAILED: %s\n' "$*" >&2; "${COMPOSE[@]}" logs --no-color --tail=80 api web migrate >&2 || true; exit 1; }
cleanup() {
  if [ "$KEEP" = "1" ]; then printf '\nKEEP=1: stack left running (%s, %s)\n' "$WEB" "$API"; return; fi
  step "docker compose down -v"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -z "${SMOKE_ENV_FILE:-}" ] && [ ! -f .env ]; then
  step ".env missing: creating it from .env.example with generated secrets"
  cp .env.example .env
  gen() { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"; }
  JWT="$(gen)"; NA="$(gen)"
  node -e "
    const fs = require('fs');
    let s = fs.readFileSync('.env', 'utf8');
    s = s.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=$JWT').replace(/^NEXTAUTH_SECRET=.*$/m, 'NEXTAUTH_SECRET=$NA');
    fs.writeFileSync('.env', s);
  "
fi

if [ "$PREBUILT" = "1" ]; then
  step "docker compose up -d --wait on the prebuilt images (mysql, redis, migrate, api, web)"
  "${COMPOSE[@]}" up -d --wait --wait-timeout 600 || fail "compose up did not reach a healthy state"
else
  step "docker compose up --build -d --wait (mysql, redis, migrate, api, web)"
  "${COMPOSE[@]}" up --build -d --wait --wait-timeout 600 || fail "compose up did not reach a healthy state"
fi

step "release step: migrate exited 0 and a second run is a no-op"
[ "$("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' migrate)" = "0" ] || fail "migrate service did not exit 0"
"${COMPOSE[@]}" run --rm migrate 2>&1 | tee /dev/stderr | grep -q "No pending migrations" || fail "a second migrate run was not a no-op"

if [ "$PREBUILT" != "1" ]; then
  step "ops: build the db-ops image (deploy/db-ops/Dockerfile: MySQL clients, GNU tar, rclone)"
  "${COMPOSE[@]}" --profile ops build db-ops >/dev/null 2>&1 || fail "db-ops image build"
fi

step "ops (roadmap 9.2): a dump before the sale, with its binary-log position (db-ops backup)"
out="$("${COMPOSE[@]}" --profile ops run --rm -T db-ops backup --label pre-sale 2>&1)" || { printf '%s\n' "$out"; fail "db-ops backup"; }
grep -q "binary-log position " <<<"$out" || { printf '%s\n' "$out"; fail "the dump recorded no binary-log position"; }
dump="$("${COMPOSE[@]}" --profile ops run --rm -T db-ops latest 2>/dev/null | tr -d '\r' | tail -n 1)"
[ -n "$dump" ] || fail "db-ops latest printed no dump"

step "probes, registration, API and web sign-in, stock, shift, sale, dashboard (scripts/smoke-flow.mjs)"
flow="$(SMOKE_API_URL="$API" SMOKE_WEB_URL="$WEB" node scripts/smoke-flow.mjs 2>&1)" || { printf '%s\n' "$flow"; fail "smoke flow"; }
printf '%s\n' "$flow"
invoice="$(printf '%s\n' "$flow" | sed -n 's/.*sale \([^ ]*\) completed.*/\1/p' | tail -n 1)"
[ -n "$invoice" ] || fail "the smoke flow printed no invoice number"

step "ops (roadmap 9.2): archive the binary logs, restore the pre-sale dump alone and rolled forward to now: only the latter holds sale $invoice"
out="$("${COMPOSE[@]}" --profile ops run --rm -T db-ops binlog-archive --flush 2>&1)" || { printf '%s\n' "$out"; fail "db-ops binlog-archive"; }
grep -qE "archived [1-9][0-9]* file" <<<"$out" || { printf '%s\n' "$out"; fail "no binary log was archived"; }
out="$("${COMPOSE[@]}" --profile ops run --rm -T db-ops restore "$dump" --database dukaanai_dump_only --create --yes 2>&1)" || { printf '%s\n' "$out"; fail "restore of the dump alone"; }
out="$("${COMPOSE[@]}" --profile ops run --rm -T db-ops restore "$dump" --database dukaanai_pitr_check --create --yes --to "$(date -u -d '+1 minute' '+%Y-%m-%d %H:%M:%S')" 2>&1)" || { printf '%s\n' "$out"; fail "point-in-time restore"; }
grep -q "then replay " <<<"$out" || { printf '%s\n' "$out"; fail "the restore plan had no replay step"; }
grep -q "^==> Replayed to " <<<"$out" || { printf '%s\n' "$out"; fail "the replay did not run"; }
# A statement as root inside the mysql container (the password stays in its environment).
sql() { "${COMPOSE[@]}" exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B -e "$0"' "$1" | tr -d '\r'; }
dump_only="$(sql "SELECT COUNT(*) FROM dukaanai_dump_only.Invoice")"
[ "$dump_only" = "0" ] || fail "the pre-sale dump holds $dump_only invoice(s); expected none"
rolled="$(sql "SELECT invoiceNumber FROM dukaanai_pitr_check.Invoice")"
[ "$rolled" = "$invoice" ] || fail "the copy rolled forward to now holds '$rolled'; expected sale $invoice, written after the dump"
printf '  the pre-sale dump holds no invoice; rolled forward to now it holds %s, the sale made after the dump\n' "$invoice"

step "ops (roadmap 9.3): the documents backup of the storage and media volumes (db-ops documents-backup)"
out="$("${COMPOSE[@]}" --profile ops run --rm -T db-ops documents-backup --label smoke 2>&1)" || { printf '%s\n' "$out"; fail "db-ops documents-backup"; }
grep -q "Documents backup written" <<<"$out" || { printf '%s\n' "$out"; fail "no documents archive was written"; }

step "ops (roadmap 9.4): the encrypted off-site copy to a local remote, verified by cryptcheck (db-ops offsite push)"
out="$("${COMPOSE[@]}" --profile ops run --rm -T -e OFFSITE_REMOTE=local:/tmp/offsite-smoke -e OFFSITE_CRYPT_PASSWORD=smoke-only-password-of-at-least-32-chars db-ops offsite push 2>&1)" || { printf '%s\n' "$out"; fail "db-ops offsite push"; }
grep -q "Off-site copy complete" <<<"$out" || { printf '%s\n' "$out"; fail "the off-site copy did not complete"; }

step "ops (roadmap 9.4): the API reads the backup status stamps into backup_last_success_timestamp_seconds"
metrics="$(curl -fsS "$API/metrics" 2>/dev/null || true)"
for kind in dump binlog documents offsite; do
  # The registry adds its default label (service="dukaanai-api") after kind.
  grep -Eq "^backup_last_success_timestamp_seconds\{kind=\"$kind\"[,}]" <<<"$metrics" || { grep backup_last <<<"$metrics" || true; fail "no backup_last_success_timestamp_seconds series for kind $kind"; }
done
"${COMPOSE[@]}" --profile ops run --rm -T db-ops status 2>&1 | grep -E "^(dump|binlog|documents|offsite) " || fail "db-ops status lists no job"

step "ops (roadmap 9.2): the binlog-archiver service archives on its own (docker compose --profile ops up -d binlog-archiver)"
"${COMPOSE[@]}" --profile ops up -d binlog-archiver >/dev/null 2>&1 || fail "binlog-archiver did not start"
for _ in $(seq 1 30); do sleep 1; "${COMPOSE[@]}" logs --no-color binlog-archiver 2>/dev/null | grep -q "Binary-log archive" && break; done
"${COMPOSE[@]}" logs --no-color binlog-archiver | grep -q "Binary-log archive" || { "${COMPOSE[@]}" logs --no-color binlog-archiver; fail "binlog-archiver did not archive within 30 s"; }

step "observability (roadmap 9.10): the monitoring stack delivers: a request found by its correlation id in Loki, Alertmanager wired and routing, Grafana provisioned, uptime probes green"
"${COMPOSE[@]}" --profile ops up -d prometheus alertmanager blackbox loki alloy grafana >/dev/null 2>&1 || fail "the monitoring stack did not start"
LOKI="http://127.0.0.1:${LOKI_PORT:-3100}"; GRAFANA="http://127.0.0.1:${GRAFANA_PORT:-3001}"; AM="http://127.0.0.1:${ALERTMANAGER_PORT:-9093}"; PROM="http://127.0.0.1:${PROMETHEUS_PORT:-9090}"; BLACKBOX="http://127.0.0.1:${BLACKBOX_PORT:-9115}"
for _ in $(seq 1 60); do curl -fsS -o /dev/null "$LOKI/ready" 2>/dev/null && curl -fsS -o /dev/null "$GRAFANA/api/health" 2>/dev/null && curl -fsS -o /dev/null "$AM/-/ready" 2>/dev/null && break; sleep 2; done
curl -fsS -o /dev/null "$LOKI/ready" || fail "Loki is not ready after 120 s"
curl -fsS -o /dev/null "$GRAFANA/api/health" || fail "Grafana is not ready after 120 s"
curl -fsS -o /dev/null "$AM/-/ready" || fail "Alertmanager is not ready after 120 s"
# A request with a client-chosen correlation id: the API echoes it and logs an access line (a 401 is fine: guard rejections are logged too).
cid="smoke-$(node -e "process.stdout.write(require('crypto').randomUUID())")"
echoed="$(curl -sS -D - -o /dev/null -H "x-correlation-id: $cid" "$API/products" | tr -d '\r' | sed -n 's/^x-correlation-id: //Ip')"
[ "$echoed" = "$cid" ] || fail "the API did not echo the correlation id (got '$echoed')"
found=""
for _ in $(seq 1 45); do
  found="$(curl -sS --get "$LOKI/loki/api/v1/query_range" --data-urlencode "query={service=\"api\"} | json | message_correlationId=\"$cid\"" --data-urlencode "since=10m" --data-urlencode "limit=5" 2>/dev/null | node -e "let b='';process.stdin.on('data',(d)=>b+=d).on('end',()=>{try{const r=JSON.parse(b).data.result;process.stdout.write(String(r.reduce((n,s)=>n+s.values.length,0)))}catch{process.stdout.write('0')}})")"
  [ "${found:-0}" -gt 0 ] 2>/dev/null && break
  sleep 2
done
[ "${found:-0}" -gt 0 ] || { "${COMPOSE[@]}" logs --no-color --tail=40 alloy loki >&2; fail "no API log line with correlation id $cid in Loki after 90 s"; }
printf '  correlation id %s found in Loki (%s line(s), query {service="api"} | json | message_correlationId=...)\n' "$cid" "$found"
# Alertmanager: Prometheus delivers to it, and a critical alert is routed to the on-call and the team receivers.
active="$(curl -fsS "$PROM/api/v1/alertmanagers" | node -e "let b='';process.stdin.on('data',(d)=>b+=d).on('end',()=>process.stdout.write(String(JSON.parse(b).data.activeAlertmanagers.length)))")"
[ "$active" = "1" ] || fail "Prometheus has $active active Alertmanager(s), expected 1"
curl -fsS -o /dev/null -X POST -H 'content-type: application/json' "$AM/api/v2/alerts" -d '[{"labels":{"alertname":"DukaanAiSmokeTest","severity":"critical","job":"smoke"},"annotations":{"summary":"compose smoke: routing check"}}]' || fail "Alertmanager refused the test alert"
receivers="$(curl -fsS --get "$AM/api/v2/alerts" --data-urlencode 'filter=alertname="DukaanAiSmokeTest"' | node -e "let b='';process.stdin.on('data',(d)=>b+=d).on('end',()=>{const a=JSON.parse(b);process.stdout.write(a.length?a[0].receivers.map((r)=>r.name).sort().join(','):'')})")"
[ "$receivers" = "oncall,team" ] || fail "the critical test alert was routed to '$receivers', expected oncall,team"
printf '  Prometheus -> Alertmanager wired; a critical alert is routed to %s (delivery channels come from ALERT_* in .env)\n' "$receivers"
# Inhibit rules (roadmap 9.18): the alert that names a cause holds back the
# probe that only sees its effect; a probe of another address stays active.
from="$(date -u +%FT%TZ)"; until="$(date -u -d '+3 min' +%FT%TZ)"
inhibit_alert() { printf '{"labels":{"alertname":"%s","severity":"critical",%s},"startsAt":"%s","endsAt":"%s"}' "$1" "$2" "$from" "$until"; }
curl -fsS -o /dev/null -X POST -H 'content-type: application/json' "$AM/api/v2/alerts" -d "[$(inhibit_alert DukaanAiCertificateExpired '"job":"blackbox-tls","instance":"https://smoke.example/login"'),$(inhibit_alert DukaanAiEndpointDown '"job":"blackbox-login","instance":"https://smoke.example/login"'),$(inhibit_alert DukaanAiEndpointDown '"job":"blackbox-login","instance":"https://other.example/login"'),$(inhibit_alert DukaanAiDependencyDown '"dependency":"smoke"'),$(inhibit_alert DukaanAiEndpointDown '"job":"blackbox-http","instance":"https://smoke.example/api/health/ready"')]" \
  || fail "Alertmanager refused the inhibition test alerts"
held="$(curl -fsS --get "$AM/api/v2/alerts" --data-urlencode 'filter=alertname="DukaanAiEndpointDown"' --data-urlencode 'filter=instance=~".*\.example/.*"' | node -e "let b='';process.stdin.on('data',(d)=>b+=d).on('end',()=>process.stdout.write(JSON.parse(b).map((a)=>a.labels.instance+'='+a.status.state).sort().join(' ')))")"
[ "$held" = "https://other.example/login=active https://smoke.example/api/health/ready=suppressed https://smoke.example/login=suppressed" ] \
  || fail "inhibit rules: EndpointDown states '$held', expected the expired certificate's and the dependency's probes suppressed, another address active"
printf '  inhibit rules: an expired certificate and a dependency outage hold back their probes (%s)\n' "$held"
# Grafana: both data sources and both dashboards are provisioned.
dash="$(curl -fsS -u "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-admin}" "$GRAFANA/api/search?type=dash-db" | node -e "let b='';process.stdin.on('data',(d)=>b+=d).on('end',()=>process.stdout.write(JSON.parse(b).map((d)=>d.uid).sort().join(',')))")"
case "$dash" in *dukaanai-logs*dukaanai-ops*) ;; *) fail "Grafana dashboards provisioned: '$dash', expected dukaanai-logs and dukaanai-ops" ;; esac
ds="$(curl -fsS -u "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-admin}" "$GRAFANA/api/datasources" | node -e "let b='';process.stdin.on('data',(d)=>b+=d).on('end',()=>process.stdout.write(JSON.parse(b).map((d)=>d.uid).sort().join(',')))")"
[ "$ds" = "loki,prometheus" ] || fail "Grafana data sources: '$ds', expected loki,prometheus"
printf '  Grafana: data sources %s, dashboards %s\n' "$ds" "$dash"
# Uptime probes: the readiness route and the login page answer the blackbox modules.
for probe in "http_2xx|http://api:3002/api/health/ready" "http_login_page|http://web:3000/login"; do
  module="${probe%%|*}"; target="${probe#*|}"
  curl -fsS --get "$BLACKBOX/probe" --data-urlencode "module=$module" --data-urlencode "target=$target" | grep -q '^probe_success 1' || fail "blackbox probe $module of $target did not succeed"
done
printf '  blackbox: readiness and login-page probes succeed\n'

if [ "${SMOKE_LIMITS_GATE:-1}" = "1" ]; then
  step "rate limits (roadmap 9.16): the API runs the production limits (SecurityConfig defaults); a shop's legitimate traffic from one address is never 429 and the brute-force limits still hold (apps/api/load/limits-gate.mjs)"
  # The compose API carries no env file, so its limits are the class defaults, the same
  # values apps/api/.env.production holds; TRUST_PROXY=1 lets the gate give every shop its
  # own forwarded address (the certify overlay opens the limits, so certify.sh skips this step).
  mkdir -p "${SMOKE_REPORT_DIR:-apps/api/load/reports}"
  LOAD_TARGET="http://127.0.0.1:${API_PORT}" LIMITS_REPORT="${SMOKE_REPORT_DIR:-apps/api/load/reports}/limits-smoke.json" node apps/api/load/limits-gate.mjs || fail "the production rate limits answered a legitimate shop 429, or the brute-force limits did not hold"
fi

step "graceful stop: SIGTERM -> readiness 503 -> exit 0 (never SIGKILL)"
"${COMPOSE[@]}" stop -t 40 api
[ "$("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' api)" = "0" ] || fail "api did not exit 0 on SIGTERM (exit $("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' api))"
api_log="$("${COMPOSE[@]}" logs --no-color api)" || fail "could not read the api log"
grep -q "Shutdown requested by SIGTERM" <<<"$api_log" || fail "api log has no shutdown line"
grep -q "Database connection closed" <<<"$api_log" || fail "api log has no Prisma close line"
"${COMPOSE[@]}" start api >/dev/null
for _ in $(seq 1 60); do sleep 2; curl -fsS -o /dev/null "$API/health/ready" && break; done
curl -fsS -o /dev/null "$API/health/ready" || fail "api not ready after restart"

printf '\nSMOKE PASSED: migrations applied, sign-in and a sale through the web and the API, the books of the day reconcile, the pre-sale dump rolled forward to now holds the sale, documents archived, encrypted off-site copy verified, backup metric exposed, the archiver service runs, a request found by its correlation id in Loki, Alertmanager routing a critical alert, Grafana provisioned, uptime probes green, production rate limits proven (0 x 429 for a shop, brute force 429), graceful stop verified.\n'
