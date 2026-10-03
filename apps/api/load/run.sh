#!/usr/bin/env bash
# Roadmap 5.8 load test runner. Boots the built API against LOAD_DATABASE_URL /
# LOAD_REDIS_URL, prepares LOAD_SHOPS shops (setup.mjs), runs load/pos-peak.yml with
# artillery and prints the baseline table (summarize.mjs). Never point it at a
# production database: it writes users, shops, products, stock and ~1,000 invoices.
#
#   LOAD_DATABASE_URL=mysql://... LOAD_REDIS_URL=redis://127.0.0.1:6379/2 load/run.sh
#
# Optional: LOAD_PORT (3019), LOAD_SHOPS (16), ARTILLERY (command, default `npx artillery@2.0.34`),
# LOAD_SKIP_BUILD=1 to reuse dist/, LOAD_REPORT_DIR (load/reports).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${LOAD_DATABASE_URL:?set LOAD_DATABASE_URL to a disposable database the API can migrate}"
: "${LOAD_REDIS_URL:?set LOAD_REDIS_URL (a Redis db index no other process uses)}"
PORT="${LOAD_PORT:-3019}"
TARGET="http://127.0.0.1:${PORT}"
ARTILLERY="${ARTILLERY:-npx artillery@2.0.34}"
REPORT_DIR="${LOAD_REPORT_DIR:-load/reports}"
mkdir -p "$REPORT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$REPORT_DIR/pos-peak-$STAMP.json"

if [ "${LOAD_SKIP_BUILD:-0}" != "1" ]; then
  echo "== build"; npx @nestjs/cli build >/dev/null
fi

echo "== boot API on :$PORT"
# Production logging profile: per-query logging (on in .env.test) would measure the log writer, not the API.
NODE_ENV=test PORT="$PORT" DATABASE_URL="$LOAD_DATABASE_URL" REDIS_URL="$LOAD_REDIS_URL" CRON_ENABLED=false \
  PRISMA_LOG_QUERIES=false \
  node dist/main > "$REPORT_DIR/api-$STAMP.log" 2>&1 &
API=$!
trap 'kill $API 2>/dev/null || true; wait $API 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do curl -sf "$TARGET/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$TARGET/api/health" >/dev/null || { echo "API did not come up; see $REPORT_DIR/api-$STAMP.log"; exit 1; }

echo "== setup"
LOAD_TARGET="$TARGET" node load/setup.mjs

echo "== artillery"
set +e
LOAD_TARGET="$TARGET" $ARTILLERY run --output "$REPORT" load/pos-peak.yml | tail -40
set -e
[ -s "$REPORT" ] || { echo "artillery wrote no report"; exit 1; }
echo "== code version: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)')"

echo "== summary ($REPORT)"
node load/summarize.mjs "$REPORT"
