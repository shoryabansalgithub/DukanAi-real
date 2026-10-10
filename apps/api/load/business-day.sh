#!/usr/bin/env bash
# Roadmap 9.17: the simulated business day on this machine. Boots a dedicated
# Redis, two API instances on one disposable database and (with UI sessions)
# the web with real authentication, then runs load/business-day.mjs with the
# plan of load/business-day.yml and the chaos hooks wired to this stack: the
# Redis is restarted once and the second API instance is killed and started
# again mid-run. The browser sessions (apps/web/e2e-load/business-day.spec.ts)
# run in parallel against the first instance through the web.
#
#   BUSINESS_DAY_DATABASE_URL='mysql://user:pass@127.0.0.1:3306/dukaanai_day' load/business-day.sh
#
# Optional: BUSINESS_DAY_MINUTES (90), BUSINESS_DAY_SHOPS (10),
# BUSINESS_DAY_CASHIERS (3), BUSINESS_DAY_UI_SHOPS (shops with two browser
# sessions; 0 = API only), BUSINESS_DAY_REDIS_PORT (6391), BUSINESS_DAY_API_PORTS
# ("3041 3042"), BUSINESS_DAY_WEB_PORT (3043), BUSINESS_DAY_SKIP_BUILD=1,
# BUSINESS_DAY_CHAOS=0, BUSINESS_DAY_REPORT_DIR (load/reports).
#
# Against a deployment that is already running (staging), call the driver
# directly with BUSINESS_DAY_TARGETS and the hook commands of that stack; see
# load/README.md and docs/BUSINESS_DAY.md.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_DIR="${BUSINESS_DAY_RUN_DIR:-$(pwd)/load/.business-day-run}"
REDIS_PORT="${BUSINESS_DAY_REDIS_PORT:-6391}"
read -r -a API_PORTS <<< "${BUSINESS_DAY_API_PORTS:-3041 3042}"
WEB_PORT="${BUSINESS_DAY_WEB_PORT:-3043}"
WEB_URL="http://localhost:${WEB_PORT}"
UI_SHOPS="${BUSINESS_DAY_UI_SHOPS:-${BUSINESS_DAY_SHOPS:-10}}"
REPORT_DIR="${BUSINESS_DAY_REPORT_DIR:-load/reports}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

start_instance() { # start_instance N: one API process on API_PORTS[N-1], pid in the run directory
  local n="$1" port="${API_PORTS[$(( $1 - 1 ))]}"
  NODE_ENV=test PORT="$port" DATABASE_URL="$BUSINESS_DAY_DATABASE_URL" REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0" \
    FRONTEND_URL="$WEB_URL" AUTH_DISABLED=false PRISMA_LOG_QUERIES=false \
    nohup node dist/main >> "$RUN_DIR/api-$n.log" 2>&1 &
  echo $! > "$RUN_DIR/api-$n.pid"
}
start_redis() {
  redis-server --port "$REDIS_PORT" --daemonize yes --save '' --appendonly no --pidfile "$RUN_DIR/redis.pid" --logfile "$RUN_DIR/redis.log" --bind 127.0.0.1 >/dev/null
  for _ in $(seq 1 20); do redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "redis did not start on $REDIS_PORT"; return 1
}
kill_port() { # kill_port PORT: whatever still listens there (an orphaned dev server of an earlier run)
  local pids; pids="$( { ss -ltnpH "sport = :$1" 2>/dev/null || true; } | { grep -o 'pid=[0-9]*' || true; } | cut -d= -f2 | sort -u)"
  [ -n "$pids" ] && { echo "   port $1 was held by pid(s) $pids: stopping them"; kill $pids 2>/dev/null || true; sleep 2; kill -9 $pids 2>/dev/null || true; }
  return 0
}
wait_health() { # wait_health URL SECONDS
  for _ in $(seq 1 "$2"); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "no answer at $1"; return 1
}

# Internal entry points used by the chaos hooks (the driver runs them with sh -c).
case "${1:-}" in
  --start-instance) : "${BUSINESS_DAY_DATABASE_URL:?}"; start_instance "$2"; exit 0 ;;
  --restart-redis) redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true; sleep 2; start_redis; exit 0 ;;
esac

: "${BUSINESS_DAY_DATABASE_URL:?set BUSINESS_DAY_DATABASE_URL to a disposable database the API can migrate}"
mkdir -p "$RUN_DIR" "$REPORT_DIR"
: > "$RUN_DIR/api-1.log"; : > "$RUN_DIR/api-2.log"
export BUSINESS_DAY_DATABASE_URL BUSINESS_DAY_RUN_DIR="$RUN_DIR" BUSINESS_DAY_REDIS_PORT="$REDIS_PORT" BUSINESS_DAY_API_PORTS="${API_PORTS[*]}" BUSINESS_DAY_WEB_PORT="$WEB_PORT"

cleanup() {
  for n in 1 2; do [ -f "$RUN_DIR/api-$n.pid" ] && kill "$(cat "$RUN_DIR/api-$n.pid")" 2>/dev/null || true; done
  # `next dev` is a tree (npx -> sh -> next -> next-server): the recorded pid is the top; take the port too.
  [ -f "$RUN_DIR/web.pid" ] && kill "$(cat "$RUN_DIR/web.pid")" 2>/dev/null || true
  pkill -f "next dev -p ${WEB_PORT}" 2>/dev/null || true
  kill_port "$WEB_PORT"
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "${BUSINESS_DAY_SKIP_BUILD:-0}" != "1" ]; then echo "== build"; npx @nestjs/cli build >/dev/null; fi
echo "== migrate $BUSINESS_DAY_DATABASE_URL"
DATABASE_URL="$BUSINESS_DAY_DATABASE_URL" npx prisma migrate deploy >/dev/null
echo "== redis on :$REDIS_PORT"
start_redis
echo "== two API instances on :${API_PORTS[0]} and :${API_PORTS[1]}"
kill_port "${API_PORTS[0]}"; kill_port "${API_PORTS[1]}"; kill_port "$WEB_PORT"
start_instance 1; start_instance 2
wait_health "http://127.0.0.1:${API_PORTS[0]}/api/health" 90
wait_health "http://127.0.0.1:${API_PORTS[1]}/api/health" 90

UI_PID=""
if [ "$UI_SHOPS" != "0" ]; then
  echo "== web on :$WEB_PORT (real authentication, API instance 1)"
  (cd ../web && NEXT_PUBLIC_AUTH_DISABLED=false NEXT_PUBLIC_API_URL="http://localhost:${API_PORTS[0]}/api" NEXTAUTH_URL="$WEB_URL" \
    NEXTAUTH_SECRET="business-day-local-secret-0123456789abcdef0123456789" \
    nohup npx next dev -p "$WEB_PORT" > "$RUN_DIR/web.log" 2>&1 & echo $! > "$RUN_DIR/web.pid")
  wait_health "$WEB_URL/login" 240
fi

REPORT="$REPORT_DIR/business-day-$STAMP.json"
STATE="$RUN_DIR/state.json"
rm -f "$STATE"
echo "== business day: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)'), report $REPORT"
set +e
BUSINESS_DAY_TARGETS="http://127.0.0.1:${API_PORTS[0]},http://127.0.0.1:${API_PORTS[1]}" \
BUSINESS_DAY_WEB_URL="$([ "$UI_SHOPS" != "0" ] && echo "$WEB_URL")" BUSINESS_DAY_UI_SHOPS="$UI_SHOPS" \
BUSINESS_DAY_STATE_FILE="$STATE" BUSINESS_DAY_REPORT="$REPORT" \
BUSINESS_DAY_KILLED_TARGET=1 \
BUSINESS_DAY_CHAOS_REDIS_RESTART="bash load/business-day.sh --restart-redis" \
BUSINESS_DAY_CHAOS_API_KILL="kill -9 \$(cat $RUN_DIR/api-2.pid)" \
BUSINESS_DAY_CHAOS_API_START="bash load/business-day.sh --start-instance 2" \
  node load/business-day.mjs &
DRIVER=$!
if [ "$UI_SHOPS" != "0" ]; then
  (cd ../web && BUSINESS_DAY_STATE_FILE="$STATE" BUSINESS_DAY_WEB_URL="$WEB_URL" BUSINESS_DAY_MINUTES="${BUSINESS_DAY_MINUTES:-90}" BUSINESS_DAY_UI_SHOPS="$UI_SHOPS" \
    npx playwright test --config playwright.business-day.config.ts > "$RUN_DIR/ui.log" 2>&1) &
  UI_PID=$!
fi
wait "$DRIVER"; rc=$?
[ -n "$UI_PID" ] && { wait "$UI_PID" || echo "(browser sessions exited non-zero; see $RUN_DIR/ui.log)"; }
set -e
echo "== driver exit $rc; logs in $RUN_DIR (api-1.log, api-2.log, web.log, ui.log, redis.log)"
exit "$rc"
