#!/usr/bin/env bash
# Certification of a release candidate (roadmap 9.12): the checklist the
# repository already runs on the source tree, re-run against the IMAGES that
# would be deployed, with every report kept in one evidence bundle.
#
#   scripts/certify/certify.sh --api IMAGE --web IMAGE --db-ops IMAGE [--out DIR] [--label TAG] [--release R] [--skip step,step] [--keep]
#
# Steps (each one is recorded PASS / FAIL / SKIPPED with its log; a failure
# never stops the run, so the bundle always holds every report, and the exit
# code is 1 when any step failed):
#   images        the digests and metadata of the three images
#   boot-matrix   every refusal case of the boot matrix on the API image (boot-matrix.sh)
#   migrate-diff  the image's migrations on MySQL 8 and MariaDB, zero drift (migrate-diff.sh)
#   smoke         the compose stack from the images: migrations, business flow through the
#                 web and the API, a CLEAN reconciliation, point-in-time restore, documents
#                 backup, off-site copy, backup metric, monitoring stack, graceful stop
#                 (scripts/compose-smoke.sh with SMOKE_PREBUILT=1; the stack stays up)
#   release       what the images say they are (OCI version and revision labels) and what the
#                 running API and web answer on /api/health; with --release R (the release
#                 workflow passes the version tag, else sha-<7>) every one must say R and the
#                 revision must be this checkout's commit (roadmap 9.21)
#   route-walk    every registered route over HTTP against the running API image, four
#                 identities (test/integration/route-walker.integration-spec.ts under CERTIFY_API_URL)
#   security      the security regression suite with every request sent to the image
#   playwright    the real-authentication browser suite against the web and API images
#   load          the 3x-peak load profile against the API image (load/run.sh, LOAD_TARGET)
#   upload-gate   twelve 300 MB uploads refused with 413, RSS and temp directory of the container
#   restore-db    scripts/db/restore-drill.sh --pitr require against the stack's MySQL
#   restore-docs  scripts/storage/restore-drill.sh on a copy of the stack's storage volume
#   restore-offsite  scripts/backup/offsite-drill.sh (encrypted copy, clean fetch, restore)
#   teardown      container logs into the bundle, then `docker compose down -v` (not with --keep)
#   drills        the failure drills of roadmap 9.18 (scripts/drills/drill-stack.sh all) on a
#                 drill stack of the same images, evidence under drills/ (CERTIFY_DRILLS=0 skips,
#                 CERTIFY_DRILL_TLS_WARN_SECONDS adds the near-expiry certificate stage)
#
# Needs: docker (compose v2), node, npm with the workspace installed (`npm ci`,
# invoice-math built: the suites boot the fixture module from the checkout),
# Chromium for Playwright (`npx playwright install --with-deps chromium` in
# apps/web), the MySQL 8 clients (mysql, mysqldump, mysqlbinlog) and rclone
# for the drills, curl. The GitHub job in .github/workflows/release.yml
# (job `certify`) prepares exactly that and runs this script on the images
# the release workflow just pushed.
#
# The API runs with the test profile's open rate limits and billing timeout
# (scripts/certify/compose.certify.yml says why); everything else is the
# reference compose stack with the candidate images.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"

API_IMAGE=""; WEB_IMAGE=""; DB_OPS_IMAGE=""; OUT=""; LABEL=""; RELEASE=""; SKIP=""; KEEP_STACK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --api) API_IMAGE="$2"; shift 2 ;;
    --web) WEB_IMAGE="$2"; shift 2 ;;
    --db-ops) DB_OPS_IMAGE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --keep) KEEP_STACK=1; shift ;;
    -h|--help) sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$API_IMAGE" ] && [ -n "$WEB_IMAGE" ] && [ -n "$DB_OPS_IMAGE" ] || { echo "usage: certify.sh --api IMAGE --web IMAGE --db-ops IMAGE [--out DIR] [--label TAG] [--release R] [--skip a,b] [--keep]" >&2; exit 2; }
for tool in docker node npm curl; do command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 2; }; done
[ -n "$LABEL" ] || LABEL="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short=7 HEAD 2>/dev/null || date -u +%Y%m%dT%H%M%SZ)"
[ -n "$OUT" ] || OUT="$(mktemp -d)/certification-$LABEL"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

MYSQL_PORT="${CERTIFY_MYSQL_PORT:-3306}"
REDIS_PORT="${CERTIFY_REDIS_PORT:-6379}"
API_PORT="${API_PORT:-3002}"
WEB_PORT="${WEB_PORT:-3000}"
API="http://127.0.0.1:${API_PORT}"
WEB="http://127.0.0.1:${WEB_PORT}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-root-local-only}"
DB_NAME="${MYSQL_DATABASE:-dukaanai}"
DB_URL="mysql://root:${MYSQL_ROOT_PASSWORD}@127.0.0.1:${MYSQL_PORT}/${DB_NAME}"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/compose.env"
JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
NEXTAUTH_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
cat > "$ENV_FILE" <<ENV
JWT_SECRET=$JWT_SECRET
NEXTAUTH_SECRET=$NEXTAUTH_SECRET
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_DATABASE=$DB_NAME
API_PORT=$API_PORT
WEB_PORT=$WEB_PORT
CERTIFY_API_IMAGE=$API_IMAGE
CERTIFY_WEB_IMAGE=$WEB_IMAGE
CERTIFY_DB_OPS_IMAGE=$DB_OPS_IMAGE
CERTIFY_MYSQL_PORT=$MYSQL_PORT
CERTIFY_REDIS_PORT=$REDIS_PORT
ENV
export COMPOSE_FILE="docker-compose.yml:scripts/certify/compose.certify.yml"
COMPOSE=(docker compose --env-file "$ENV_FILE")
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

printf 'Certification of %s\n  api     %s\n  web     %s\n  db-ops  %s\n  bundle  %s\n' "$LABEL" "$API_IMAGE" "$WEB_IMAGE" "$DB_OPS_IMAGE" "$OUT"

STEPS=(); RESULTS=(); SECONDS_TAKEN=(); NOTES=()
skipped() { case ",$SKIP," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
record() { STEPS+=("$1"); RESULTS+=("$2"); SECONDS_TAKEN+=("$3"); NOTES+=("$4"); }
# run_step NAME "description" command...: the command's output goes to OUT/NAME.log.
run_step() {
  local name="$1" desc="$2"; shift 2
  local log="$OUT/$name.log"
  if skipped "$name"; then printf '\n==> %s: SKIPPED (--skip)\n' "$name"; record "$name" SKIPPED 0 "$desc"; return 0; fi
  printf '\n==> %s: %s\n' "$name" "$desc"
  local start rc; start="$(date +%s)"
  if "$@" >"$log" 2>&1; then rc=0; else rc=$?; fi
  tail -n 12 "$log" | sed 's/^/    /'
  local took=$(( $(date +%s) - start ))
  if [ "$rc" = 0 ]; then record "$name" PASS "$took" "$desc"; printf '    -> PASS (%ss)\n' "$took"; else record "$name" FAIL "$took" "$desc (exit $rc)"; printf '    -> FAIL, exit %s (%ss), see %s\n' "$rc" "$took" "$log"; fi
  return 0
}
stack_ready() { curl -fsS -o /dev/null "$API/api/health/ready" 2>/dev/null; }
require_stack() { stack_ready || { echo "the stack is not ready at $API/api/health/ready (did the smoke step fail?)"; return 1; }; }

# ---- steps -----------------------------------------------------------------
step_prepare() {
  (cd apps/api && npx prisma generate) || return 1
  [ -d packages/invoice-math/dist ] || npm run build -w @dukaanai/invoice-math || return 1
  node -e "process.exit(require('fs').existsSync('apps/api/node_modules') || require('fs').existsSync('node_modules/@nestjs/core') ? 0 : 1)" || { echo "the workspace is not installed (npm ci)"; return 1; }
}
step_images() {
  docker image inspect "$API_IMAGE" "$WEB_IMAGE" "$DB_OPS_IMAGE" > "$OUT/images.json" || return 1
  node -e '
    const images = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const i of images) console.log(`${(i.RepoTags || []).join(",") || i.Id}\n  digest  ${(i.RepoDigests || []).join(", ") || "(local build, not pushed)"}\n  id      ${i.Id}\n  created ${i.Created}\n  size    ${(i.Size / 1048576).toFixed(1)} MB`);
  ' "$OUT/images.json"
}
step_boot_matrix() { bash scripts/certify/boot-matrix.sh "$API_IMAGE" "$OUT/boot-matrix"; }
step_migrate_diff() { bash scripts/certify/migrate-diff.sh "$API_IMAGE" "$OUT/migrate-diff"; }
step_smoke() {
  # The certify overlay opens the rate limits so one address can drive the load profile; the
  # production-limits gate (roadmap 9.16) runs in the reference smoke of CI, not here.
  KEEP=1 SMOKE_PREBUILT=1 SMOKE_ENV_FILE="$ENV_FILE" SMOKE_LIMITS_GATE=0 API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" bash scripts/compose-smoke.sh
  local rc=$?
  # The monitoring stack and the archiver proved themselves; free the host for the suites and the load.
  "${COMPOSE[@]}" --profile ops stop prometheus alertmanager blackbox loki alloy grafana binlog-archiver >/dev/null 2>&1 || true
  return $rc
}
step_release() {
  local failed=0 image version revision
  for image in "$API_IMAGE" "$WEB_IMAGE" "$DB_OPS_IMAGE"; do
    version="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image")" || return 1
    revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")" || return 1
    printf '%s\n  version label   %s\n  revision label  %s\n' "$image" "${version:-(none)}" "${revision:-(none)}"
    if [ -n "$RELEASE" ]; then
      [ "$version" = "$RELEASE" ] || { echo "  -> expected version $RELEASE"; failed=1; }
      [ "$revision" = "$COMMIT" ] || { echo "  -> expected revision $COMMIT (this checkout)"; failed=1; }
    fi
  done
  require_stack || return 1
  local base answer
  for base in "$API" "$WEB"; do
    answer="$(curl -fsS --max-time 10 "$base/api/health" | node -e 'let b="";process.stdin.on("data",(d)=>b+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(b).release ?? ""))}catch{process.exit(1)}})')" || { echo "GET $base/api/health did not answer JSON"; failed=1; continue; }
    printf 'GET %s/api/health  release %s\n' "$base" "${answer:-(none)}"
    if [ -n "$RELEASE" ] && [ "$answer" != "$RELEASE" ]; then echo "  -> expected $RELEASE"; failed=1; fi
  done
  [ -n "$RELEASE" ] || echo "(no --release given: reported, not checked)"
  return $failed
}
suite() { # suite NAME PATTERN: one jest run of the integration config with every HTTP call sent to the image
  local name="$1" pattern="$2"
  require_stack || return 1
  mkdir -p "$OUT/$name"
  (cd apps/api && CERTIFY_API_URL="$API" CERTIFY_REPORT_DIR="$OUT/$name" JWT_SECRET="$JWT_SECRET" \
    TEST_DATABASE_URL="$DB_URL?connection_limit=25&pool_timeout=120" TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/1" \
    npx jest --config test/jest-integration.json --runInBand --testPathPatterns "$pattern" --json --outputFile="$OUT/$name/jest.json")
}
step_route_walk() { suite route-walk 'route-walker'; }
step_security() { suite security '\.security-spec\.ts$'; }
step_exploits() {
  require_stack || return 1
  mkdir -p "$OUT/exploits"
  # Every audit exploit replayed over HTTP against the API container, as an attacker would
  # (roadmap 9.13). The two role-escalation exploits seed a VIEWER and a MANAGER directly, as
  # the real-auth suite does; the open-redirect check loads the web container's login page.
  (cd apps/api && EXPLOIT_TARGET="$API/api" EXPLOIT_WEB_URL="$WEB" EXPLOIT_DATABASE_URL="$DB_URL" EXPLOIT_REPORT="$OUT/exploits/exploit-replay.json" \
    npx ts-node test/certification/exploit-replay.ts)
}
step_playwright() {
  require_stack || return 1
  mkdir -p "$OUT/playwright"
  local rc=0
  (cd apps/web && rm -rf playwright-report-auth test-results-auth && CI=true E2E_EXTERNAL_SERVERS=1 E2E_AUTH_WEB_PORT="$WEB_PORT" E2E_AUTH_API_PORT="$API_PORT" \
    E2E_DATABASE_URL="$DB_URL" E2E_JSON_REPORT="$OUT/playwright/real-auth.json" npx playwright test --config playwright.auth.config.ts) || rc=$?
  [ -d apps/web/playwright-report-auth ] && cp -r apps/web/playwright-report-auth "$OUT/playwright/html-report"
  [ -d apps/web/test-results-auth ] && cp -r apps/web/test-results-auth "$OUT/playwright/test-results"
  return $rc
}
step_load() {
  require_stack || return 1
  (cd apps/api && LOAD_TARGET="$API" LOAD_REPORT_DIR="$OUT/load" bash load/run.sh)
}
step_business_day() {
  require_stack || return 1
  mkdir -p "$OUT/business-day"
  # Roadmap 9.17, shortened: CERTIFY_BUSINESS_DAY_MINUTES (6) of the compressed day over
  # CERTIFY_BUSINESS_DAY_SHOPS (3) shops, Redis restarted and the API container killed and
  # started again through compose, one shop with the two browser sessions. The stack has a
  # single API instance, so every session waits the outage out with the same idempotency key.
  (cd apps/api && BUSINESS_DAY_TARGETS="${API%/api}" BUSINESS_DAY_DATABASE_URL="$DB_URL" BUSINESS_DAY_WEB_URL="$WEB" \
    BUSINESS_DAY_MINUTES="${CERTIFY_BUSINESS_DAY_MINUTES:-6}" BUSINESS_DAY_SHOPS="${CERTIFY_BUSINESS_DAY_SHOPS:-3}" BUSINESS_DAY_CASHIERS=2 BUSINESS_DAY_UI_SHOPS=1 \
    BUSINESS_DAY_STATE_FILE="$OUT/business-day/state.json" BUSINESS_DAY_REPORT="$OUT/business-day/business-day.json" \
    BUSINESS_DAY_CHAOS_REDIS_RESTART="${COMPOSE[*]} restart redis" BUSINESS_DAY_CHAOS_API_KILL="${COMPOSE[*]} kill api" BUSINESS_DAY_CHAOS_API_START="${COMPOSE[*]} start api" \
    node load/business-day.mjs) &
  local driver=$!
  (cd apps/web && BUSINESS_DAY_STATE_FILE="$OUT/business-day/state.json" BUSINESS_DAY_WEB_URL="$WEB" BUSINESS_DAY_MINUTES="${CERTIFY_BUSINESS_DAY_MINUTES:-6}" BUSINESS_DAY_UI_SHOPS=1 \
    BUSINESS_DAY_UI_JSON="$OUT/business-day/ui-playwright.json" npx playwright test --config playwright.business-day.config.ts > "$OUT/business-day/ui.log" 2>&1) &
  local ui=$!
  local rc=0
  wait "$driver" || rc=$?
  wait "$ui" || echo "(browser sessions exited non-zero; see business-day/ui.log)"
  return $rc
}
step_upload_gate() {
  require_stack || return 1
  local container; container="$("${COMPOSE[@]}" ps -q api)"
  [ -n "$container" ] || { echo "no api container"; return 1; }
  (cd apps/api && LOAD_TARGET="$API" UPLOAD_GATE_CONTAINER="$container" LOAD_REPORT_DIR="$OUT/upload-gate" bash load/upload-gate.sh)
}
step_restore_db() {
  require_stack || return 1
  for tool in mysql mysqldump mysqlbinlog; do command -v "${tool}" >/dev/null 2>&1 || command -v "${tool/mysql/mariadb}" >/dev/null 2>&1 || { echo "$tool is required for the database restore drill"; return 1; }; done
  # The drill compares every table's row count on both sides, so the source
  # must be quiet: the API container is frozen (its workers and crons with
  # it) for the duration and thawed afterwards, whatever the outcome.
  "${COMPOSE[@]}" pause api >/dev/null 2>&1 || { echo "could not pause the api container"; return 1; }
  local rc=0
  DATABASE_URL="$DB_URL" bash scripts/db/restore-drill.sh --pitr require || rc=$?
  "${COMPOSE[@]}" unpause api >/dev/null 2>&1 || { echo "could not unpause the api container"; return 1; }
  return $rc
}
# A copy of the stack's storage root (and product images, when any) on this
# machine: the documents and off-site drills read a directory, and a volume
# of a running container has none on the host. Copied once, by whichever
# drill runs first; MEDIA_DIR is set when the media directory exists.
MEDIA_DIR=""
copy_documents() {
  [ -d "$WORK/documents/storage" ] && return 0
  local container; container="$("${COMPOSE[@]}" ps -q api)"
  [ -n "$container" ] || { echo "no api container"; return 1; }
  mkdir -p "$WORK/documents"
  docker cp "$container:/var/lib/dukaanai/storage" "$WORK/documents/storage" || return 1
  if docker exec "$container" test -d /app/apps/api/uploads/media; then
    docker cp "$container:/app/apps/api/uploads/media" "$WORK/documents/media" || return 1
    MEDIA_DIR="$WORK/documents/media"
  fi
  echo "copied the storage root ($(find "$WORK/documents/storage" -type f | wc -l) files)${MEDIA_DIR:+ and the media directory ($(find "$MEDIA_DIR" -type f | wc -l) files)}"
}
step_restore_docs() {
  require_stack || return 1
  copy_documents || return 1
  bash scripts/storage/restore-drill.sh --root "$WORK/documents/storage" ${MEDIA_DIR:+--media "$MEDIA_DIR"}
}
step_restore_offsite() {
  require_stack || return 1
  command -v rclone >/dev/null 2>&1 || { echo "rclone is required for the off-site drill"; return 1; }
  copy_documents || return 1
  DATABASE_URL="$DB_URL" OFFSITE_REMOTE="local:$WORK/offsite-bucket" OFFSITE_CRYPT_PASSWORD="certify-only-password-of-at-least-32-characters" \
    bash scripts/backup/offsite-drill.sh --root "$WORK/documents/storage" ${MEDIA_DIR:+--media "$MEDIA_DIR"}
}
step_teardown() {
  "${COMPOSE[@]}" --profile ops logs --no-color --tail=400 api web migrate mysql redis > "$OUT/compose-logs.txt" 2>&1 || true
  "${COMPOSE[@]}" --profile ops --profile edge ps -a > "$OUT/compose-ps.txt" 2>&1 || true
  if [ "$KEEP_STACK" = 1 ]; then echo "--keep: the stack stays up ($WEB, $API); tear it down with: COMPOSE_FILE=$COMPOSE_FILE docker compose --env-file $ENV_FILE --profile ops down -v"; return 0; fi
  "${COMPOSE[@]}" --profile ops --profile edge down -v --remove-orphans
}

# Roadmap 9.18: the failure drills on a drill stack of the same three images
# (after the main stack is gone, so the ports are free): the API killed during
# a checkout burst, MySQL stopped 60 s, Redis stopped 5 minutes, the documents
# volume filled, an expired edge certificate, the database restored from the
# off-site copy to the second before a chosen sale. Each drill records what
# users (and a browser) saw, what Prometheus and Alertmanager said, the time to
# recovery and the reconciliation afterwards, and fails on a lost or
# duplicated sale, a user path that never recovers, an expected alert that
# never fires or a reconciliation that is not CLEAN.
step_drills() {
  [ "${CERTIFY_DRILLS:-1}" = "1" ] || { echo "CERTIFY_DRILLS=0"; return 0; }
  docker tag "$API_IMAGE" dukaanai-api && docker tag "$WEB_IMAGE" dukaanai-web && docker tag "$DB_OPS_IMAGE" dukaanai-db-ops || return 1
  local dir="$OUT/drills-work" rc=0
  mkdir -p "$dir"
  DRILL_DIR="$dir" bash scripts/drills/drill-stack.sh up || { DRILL_DIR="$dir" bash scripts/drills/drill-stack.sh down >/dev/null 2>&1; return 1; }
  DRILL_DIR="$dir" DRILL_TLS_WARN_SECONDS="${CERTIFY_DRILL_TLS_WARN_SECONDS:-0}" bash scripts/drills/drill-stack.sh all || rc=$?
  mkdir -p "$OUT/drills" && cp -r "$dir/evidence/." "$OUT/drills/" 2>/dev/null
  DRILL_DIR="$dir" bash scripts/drills/drill-stack.sh compose logs --no-color --tail=400 api web edge > "$OUT/drills/compose-logs.txt" 2>&1 || true
  DRILL_DIR="$dir" bash scripts/drills/drill-stack.sh down >/dev/null 2>&1 || true
  rm -rf "$dir"
  return $rc
}

# ---- run -------------------------------------------------------------------
run_step prepare "the checkout can boot the fixture module (prisma client generated, invoice-math built, workspace installed)" step_prepare
run_step images "digests and metadata of the three images" step_images
run_step boot-matrix "every refusal case of the boot matrix on the API image" step_boot_matrix
run_step migrate-diff "the image's migrations on MySQL 8 and MariaDB: deploy, diff --exit-code, status, redeploy" step_migrate_diff
run_step smoke "compose stack from the images: migrations, business flow, reconciliation, point-in-time restore, documents and off-site backups, monitoring, graceful stop" step_smoke
run_step release "the release the images carry (OCI labels) and the running API and web report on /api/health${RELEASE:+, all $RELEASE}" step_release
run_step route-walk "every registered route over HTTP against the API image, four identities" step_route_walk
run_step security "the security regression suite with every request sent to the API image" step_security
run_step exploits "every audit exploit replayed over HTTP against the running images, each refused with its documented code" step_exploits
run_step playwright "the real-authentication browser suite against the web and API images" step_playwright
run_step load "the 3x-peak load profile against the API image (checkout p95 < 500 ms, zero errors)" step_load
run_step business-day "a shortened simulated business day (roadmap 9.17): sales, returns, cancellations, repayments, receipts, shifts, browser sessions, Redis restarted and the API killed mid-run; no lost or duplicated invoice, reconciliation CLEAN" step_business_day
run_step upload-gate "twelve 300 MB uploads refused with 413; container RSS and temp directory" step_upload_gate
run_step restore-db "database backup and restore drill with point in time (--pitr require) on the stack's MySQL" step_restore_db
run_step restore-docs "documents backup and restore drill on a copy of the stack's storage root and media" step_restore_docs
run_step restore-offsite "off-site drill: encrypted copy to a local remote, clean-machine fetch, documents and dump restored" step_restore_offsite
run_step teardown "container logs into the bundle, then docker compose down -v" step_teardown
run_step drills "failure drills (roadmap 9.18) on a drill stack of the images: API killed in a checkout burst, MySQL 60 s, Redis 5 min, storage volume full, expired certificate, off-site restore to before a chosen sale; users, alerts, recovery, reconciliation" step_drills

# ---- summary -----------------------------------------------------------------
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
overall=PASS
for r in "${RESULTS[@]}"; do [ "$r" = FAIL ] && overall=FAIL; done
{
  printf '# Certification of %s\n\n' "$LABEL"
  printf -- '- Result: **%s**\n- Commit: `%s`\n- Started: %s, finished: %s\n- Bundle: every log named below sits next to this file\n\n' "$overall" "$COMMIT" "$STARTED_AT" "$FINISHED_AT"
  printf '## Images\n\n| Image | Reference | Digest |\n|---|---|---|\n'
  if [ -f "$OUT/images.json" ]; then
    node -e '
      const images = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const names = ["api", "web", "db-ops"];
      images.forEach((i, n) => console.log(`| ${names[n] || "?"} | ${(i.RepoTags || []).join(", ") || i.Id} | ${(i.RepoDigests || []).join(", ") || "(local build)"} |`));
    ' "$OUT/images.json"
  else
    printf '| api | %s | not inspected |\n| web | %s | not inspected |\n| db-ops | %s | not inspected |\n' "$API_IMAGE" "$WEB_IMAGE" "$DB_OPS_IMAGE"
  fi
  printf '\n## Steps\n\n| Step | Result | Seconds | What | Log |\n|---|---|---:|---|---|\n'
  for i in "${!STEPS[@]}"; do
    printf '| %s | %s | %s | %s | `%s.log` |\n' "${STEPS[$i]}" "${RESULTS[$i]}" "${SECONDS_TAKEN[$i]}" "${NOTES[$i]}" "${STEPS[$i]}"
  done
  printf '\n## Reports\n\n'
  printf -- '- `boot-matrix/boot-matrix.json`: one row per refusal case (exit code, marker, reason), with `case-<n>.log` and `case-<n>.env`\n'
  printf -- '- `migrate-diff/migrate-diff.json`: per engine deploy / diff / status / redeploy with the logs\n'
  printf -- '- `smoke.log`: the compose smoke transcript (business flow, reconciliation, point-in-time restore, backups, monitoring, graceful stop)\n'
  printf -- '- `route-walk/route-walk.json`: every route x identity with its status; `route-walk/jest.json` the assertions\n'
  printf -- '- `security/jest.json`: the security regression suite (open findings are `it.failing`, see apps/api/test/security/README.md)\n'
  printf -- '- `exploits/exploit-replay.json`: every audit exploit replayed over HTTP, one row per exploit with its status and the documented refusal (roadmap 9.13)\n'
  printf -- '- `playwright/real-auth.json`, `playwright/html-report/`: the real-authentication browser suite\n'
  printf -- '- `load/pos-peak-*.json` and `load.log`: the artillery report and the gate table (docs/LOAD_TEST_BASELINE.md for the format)\n'
  printf -- '- `upload-gate.log`: one line per upload, RSS before / peak / after, temp directory leftovers, the control upload\n'
  printf -- '- `restore-db.log`, `restore-docs.log`, `restore-offsite.log`: the three drills\n'
  printf -- '- `compose-logs.txt`, `compose-ps.txt`: the containers at the end\n'
  printf '\n## Deviations from production configuration\n\n'
  printf 'The API container ran with the test profile rate limits and billing timeout from `scripts/certify/compose.certify.yml` (RATE_LIMIT_*_LIMIT and AUTH_RATE_LIMIT_* opened, BILLING_GATEWAY_TIMEOUT_MS 60000): every suite and the load profile come from one address, which the production limits refuse by design. Roadmap 9.16 exercises the production values. MySQL and Redis were published on the host for the drills and the fixtures. Everything else is the reference compose stack with the candidate images.\n'
} > "$OUT/SUMMARY.md"
for i in "${!STEPS[@]}"; do printf '%s\t%s\t%s\t%s\n' "${STEPS[$i]}" "${RESULTS[$i]}" "${SECONDS_TAKEN[$i]}" "${NOTES[$i]}"; done > "$WORK/steps.tsv"
node -e '
  const fs = require("fs");
  const [out, stepsFile, label, commit, overall, started, finished] = process.argv.slice(1);
  const steps = fs.readFileSync(stepsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => { const [step, result, seconds, note] = l.split("\t"); return { step, result, seconds: Number(seconds), note, log: `${step}.log` }; });
  fs.writeFileSync(out + "/summary.json", JSON.stringify({ label, commit, result: overall, startedAt: started, finishedAt: finished, steps }, null, 2) + "\n");
' "$OUT" "$WORK/steps.tsv" "$LABEL" "$COMMIT" "$overall" "$STARTED_AT" "$FINISHED_AT"
printf '\n==> %s\n' "$(sed -n '3p' "$OUT/SUMMARY.md")"
printf '    bundle: %s\n' "$OUT"
[ "$overall" = PASS ]
