#!/usr/bin/env bash
# Roadmap 5 exit gate, upload half: a 300 MB multipart upload is refused with
# 413 and the process does not grow with it. Boots the built API against
# LOAD_DATABASE_URL / LOAD_REDIS_URL (disposable, never production), registers
# an owner through the public routes, creates a product, then sends
# UPLOAD_GATE_ROUNDS (12) uploads of UPLOAD_GATE_MB (300) MB to the media route
# while sampling the API's resident set size. Prints one line per upload, the
# RSS before / peak / after, the temp directory leftovers and a small valid
# upload as the control; exits non-zero when any upload is not 413, a temp file
# is left behind, or RSS after the run is more than UPLOAD_GATE_MAX_GROWTH_MB
# (64) above the value before it.
#
#   LOAD_DATABASE_URL=mysql://... LOAD_REDIS_URL=redis://127.0.0.1:6379/2 load/upload-gate.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${LOAD_DATABASE_URL:?set LOAD_DATABASE_URL to a disposable database the API can migrate}"
: "${LOAD_REDIS_URL:?set LOAD_REDIS_URL (a Redis db index no other process uses)}"
PORT="${LOAD_PORT:-3019}"
BASE="http://127.0.0.1:${PORT}/api"
ROUNDS="${UPLOAD_GATE_ROUNDS:-12}"
MB="${UPLOAD_GATE_MB:-300}"
MAX_GROWTH="${UPLOAD_GATE_MAX_GROWTH_MB:-64}"
REPORT_DIR="${LOAD_REPORT_DIR:-load/reports}"
mkdir -p "$REPORT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ "${LOAD_SKIP_BUILD:-0}" != "1" ]; then
  echo "== build"; npx @nestjs/cli build >/dev/null
fi
UPLOAD_TMP="uploads/tmp-upload-gate"
rm -rf "$UPLOAD_TMP"; mkdir -p "$UPLOAD_TMP"

echo "== boot API on :$PORT"
NODE_ENV=test PORT="$PORT" DATABASE_URL="$LOAD_DATABASE_URL" REDIS_URL="$LOAD_REDIS_URL" CRON_ENABLED=false \
  PRISMA_LOG_QUERIES=false UPLOAD_TEMP_DIR="$UPLOAD_TMP" \
  node dist/main > "$REPORT_DIR/upload-gate-api-$STAMP.log" 2>&1 &
API=$!
trap 'kill $API 2>/dev/null || true; wait $API 2>/dev/null || true; rm -rf "$TMP_DIR"' EXIT
for _ in $(seq 1 90); do curl -sf "$BASE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$BASE/health" >/dev/null || { echo "API did not come up; see $REPORT_DIR/upload-gate-api-$STAMP.log"; exit 1; }
rss() { awk '/VmRSS/ {printf "%.1f", $2/1024}' "/proc/$API/status"; }

echo "== owner and product through the public routes"
SUFFIX="$(head -c 8 /proc/sys/kernel/random/uuid)"
EMAIL="gate-${SUFFIX}@load.local"; PASSWORD="Gate-${SUFFIX}-Passw0rd!"
curl -sf -X POST "$BASE/auth/register" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Gate Owner\",\"shopName\":\"Gate shop $SUFFIX\"}" >/dev/null
TOKEN=$(curl -sf -X POST "$BASE/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))')
PRODUCT=$(curl -sf -X POST "$BASE/products" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"name\":\"Gate product\",\"sku\":\"GATE-$SUFFIX\",\"costPrice\":10,\"sellingPrice\":20,\"mrp\":25,\"wholesalePrice\":15,\"unit\":\"PCS\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')

echo "== $MB MB file with a PNG header"
BIG="$TMP_DIR/big.png"; SMALL="$TMP_DIR/small.png"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' > "$BIG"
dd if=/dev/zero bs=1M count="$MB" status=none >> "$BIG"
{ printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR'; head -c 5000 /dev/zero | tr '\0' '*'; } > "$SMALL"

BEFORE=$(rss); PEAK=$BEFORE; FAIL=0
echo "RSS before: $BEFORE MB"
for n in $(seq 1 "$ROUNDS"); do
  START=$(date +%s.%N)
  CODE=$(curl -s -o "$TMP_DIR/resp.json" -w '%{http_code}' -X POST "$BASE/media/upload/product/$PRODUCT" -H "authorization: Bearer $TOKEN" -F "file=@$BIG;type=image/png")
  ELAPSED=$(node -e "console.log(((Date.now()/1000) - $START).toFixed(2))")
  NOW=$(rss); PEAK=$(node -e "console.log(Math.max($PEAK, $NOW).toFixed(1))")
  echo "upload $n: HTTP $CODE in ${ELAPSED}s, RSS now $NOW MB"
  [ "$CODE" = "413" ] || FAIL=1
done
sleep 2
AFTER=$(rss)
LEFT=$(find "$UPLOAD_TMP" -type f | wc -l)
GROWTH=$(node -e "console.log(($AFTER - $BEFORE).toFixed(1))")
echo "RSS before $BEFORE MB, peak $PEAK MB, after $AFTER MB (growth $GROWTH MB, allowed $MAX_GROWTH MB)"
echo "temp dir leftovers: $LEFT"
SMALL_CODE=$(curl -s -o "$TMP_DIR/small.json" -w '%{http_code}' -X POST "$BASE/media/upload/product/$PRODUCT" -H "authorization: Bearer $TOKEN" -F "file=@$SMALL;type=image/png")
echo "control: a 5 KB PNG answers HTTP $SMALL_CODE"
[ "$LEFT" = "0" ] || FAIL=1
[ "$SMALL_CODE" = "201" ] || FAIL=1
node -e "process.exit(($AFTER - $BEFORE) <= $MAX_GROWTH ? 0 : 1)" || FAIL=1
echo "== code version: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)')"
if [ "$FAIL" = "0" ]; then echo "Upload gate: PASS"; else echo "Upload gate: FAIL"; exit 1; fi
