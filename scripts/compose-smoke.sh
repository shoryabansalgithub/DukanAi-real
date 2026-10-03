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
set -euo pipefail
cd "$(dirname "$0")/.."

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-3002}"
API="http://127.0.0.1:${API_PORT}/api"
WEB="http://127.0.0.1:${WEB_PORT}"
KEEP="${KEEP:-0}"
COMPOSE=(docker compose)
step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nSMOKE FAILED: %s\n' "$*" >&2; "${COMPOSE[@]}" logs --no-color --tail=80 api web migrate >&2 || true; exit 1; }
cleanup() {
  if [ "$KEEP" = "1" ]; then printf '\nKEEP=1: stack left running (%s, %s)\n' "$WEB" "$API"; return; fi
  step "docker compose down -v"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ ! -f .env ]; then
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

step "docker compose up --build -d --wait (mysql, redis, migrate, api, web)"
"${COMPOSE[@]}" up --build -d --wait --wait-timeout 600 || fail "compose up did not reach a healthy state"

step "release step: migrate exited 0 and a second run is a no-op"
[ "$("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' migrate)" = "0" ] || fail "migrate service did not exit 0"
"${COMPOSE[@]}" run --rm migrate 2>&1 | tee /dev/stderr | grep -q "No pending migrations" || fail "a second migrate run was not a no-op"

step "probes, registration, API and web sign-in, stock, shift, sale, dashboard (scripts/smoke-flow.mjs)"
SMOKE_API_URL="$API" SMOKE_WEB_URL="$WEB" node scripts/smoke-flow.mjs || fail "smoke flow"

step "graceful stop: SIGTERM -> readiness 503 -> exit 0 (never SIGKILL)"
"${COMPOSE[@]}" stop -t 40 api
[ "$("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' api)" = "0" ] || fail "api did not exit 0 on SIGTERM (exit $("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' api))"
"${COMPOSE[@]}" logs --no-color api | grep -q "Shutdown requested by SIGTERM" || fail "api log has no shutdown line"
"${COMPOSE[@]}" logs --no-color api | grep -q "Database connection closed" || fail "api log has no Prisma close line"
"${COMPOSE[@]}" start api >/dev/null
for _ in $(seq 1 60); do sleep 2; curl -fsS -o /dev/null "$API/health/ready" && break; done
curl -fsS -o /dev/null "$API/health/ready" || fail "api not ready after restart"

printf '\nSMOKE PASSED: migrations applied, sign-in and a sale through the web and the API, graceful stop verified.\n'
