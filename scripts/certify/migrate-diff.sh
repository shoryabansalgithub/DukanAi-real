#!/usr/bin/env bash
# Migrations of the API image on MySQL 8 and MariaDB (roadmap 9.12, the
# phase 8 exit gate re-run on the candidate): for each engine a fresh server
# is started in a container, the image's own Prisma CLI
# (`/app/node_modules/.bin/prisma migrate deploy`; the image has no npx)
# applies every migration it carries, `prisma migrate diff` from the
# resulting database to the image's prisma/schema.prisma must be empty
# (--exit-code), `migrate status` must report nothing pending and a second
# deploy must be a no-op.
#
#   scripts/certify/migrate-diff.sh IMAGE OUT_DIR
#
# OUT_DIR receives <engine>-deploy.log, <engine>-diff.log, <engine>-status.log,
# <engine>-redeploy.log and migrate-diff.json. Exit 1 on any difference.
set -uo pipefail
IMAGE="${1:?usage: migrate-diff.sh IMAGE OUT_DIR}"
OUT="${2:?usage: migrate-diff.sh IMAGE OUT_DIR}"
mkdir -p "$OUT"
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

MYSQL8_IMAGE="${CERTIFY_MYSQL8_IMAGE:-mysql:8.0}"
MARIADB_IMAGE="${CERTIFY_MARIADB_IMAGE:-mariadb:10.11}"
NET="certify-diff-$$"
PASSWORD="certify-only"
failed=0
: > "$OUT/results.tsv"

cleanup() {
  docker rm -f "certify-mysql8-$$" "certify-mariadb-$$" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$NET" >/dev/null || { echo "cannot create the docker network $NET" >&2; exit 2; }

# engine <label> <image> [server arguments...]
engine() {
  local label="$1" image="$2"; shift 2
  local name="certify-$label-$$"
  local url="mysql://root:$PASSWORD@$name:3306/dukaanai"
  local verdict=PASS step
  echo "== $label ($image)"
  docker run -d --name "$name" --network "$NET" -e MYSQL_ROOT_PASSWORD="$PASSWORD" -e MYSQL_DATABASE=dukaanai "$image" "$@" >/dev/null \
    || { echo "   the $label server did not start"; printf '%s\t%s\tstart\n' "$label" FAIL >> "$OUT/results.tsv"; failed=1; return; }
  local ready=0
  for _ in $(seq 1 90); do
    # The MySQL image answers on a socket only while it initialises; the TCP ping is the real server.
    if docker exec "$name" sh -c "mysqladmin ping -h127.0.0.1 -uroot -p$PASSWORD --silent 2>/dev/null || mariadb-admin ping -h127.0.0.1 -uroot -p$PASSWORD --silent 2>/dev/null" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" != 1 ]; then
    docker logs "$name" > "$OUT/$label-server.log" 2>&1
    echo "   the $label server was not ready after 180 s"; printf '%s\t%s\tready\n' "$label" FAIL >> "$OUT/results.tsv"; failed=1; return
  fi
  run() { docker run --rm --network "$NET" -e DATABASE_URL="$url" "$IMAGE" "$@"; }

  step=deploy
  run /app/node_modules/.bin/prisma migrate deploy > "$OUT/$label-deploy.log" 2>&1 || verdict=FAIL
  echo "   migrate deploy: $(grep -c 'migration' "$OUT/$label-deploy.log") lines mentioning migrations, exit $([ "$verdict" = PASS ] && echo 0 || echo non-zero)"

  if [ "$verdict" = PASS ]; then
    step=diff
    run /app/node_modules/.bin/prisma migrate diff --from-url "$url" --to-schema-datamodel prisma/schema.prisma --exit-code > "$OUT/$label-diff.log" 2>&1 || verdict=FAIL
    echo "   migrate diff --exit-code: $([ "$verdict" = PASS ] && echo 'no difference' || echo 'DIFFERENCE')"
  fi
  if [ "$verdict" = PASS ]; then
    step=status
    run /app/node_modules/.bin/prisma migrate status > "$OUT/$label-status.log" 2>&1
    grep -q "Database schema is up to date" "$OUT/$label-status.log" || verdict=FAIL
    echo "   migrate status: $(grep -E 'up to date|pending|not yet' "$OUT/$label-status.log" | head -n 1)"
  fi
  if [ "$verdict" = PASS ]; then
    step=redeploy
    run /app/node_modules/.bin/prisma migrate deploy > "$OUT/$label-redeploy.log" 2>&1
    grep -q "No pending migrations" "$OUT/$label-redeploy.log" || verdict=FAIL
    echo "   second deploy: $(grep -E 'No pending|applied' "$OUT/$label-redeploy.log" | head -n 1)"
  fi
  [ "$verdict" = PASS ] && step=all
  printf '%s\t%s\t%s\n' "$label" "$verdict" "$step" >> "$OUT/results.tsv"
  [ "$verdict" = PASS ] || failed=1
  docker rm -f "$name" >/dev/null 2>&1 || true
}

# Migrations create the ledger immutability triggers; with the binary log on
# (MySQL 8 default) that needs the same flag the compose server runs with.
engine mysql8 "$MYSQL8_IMAGE" mysqld --log-bin-trust-function-creators=1
engine mariadb "$MARIADB_IMAGE"

node - "$OUT" "$IMAGE" "$MYSQL8_IMAGE" "$MARIADB_IMAGE" <<'NODE'
const fs = require('fs');
const path = require('path');
const [out, image, mysql8, mariadb] = process.argv.slice(2);
const rows = fs.readFileSync(path.join(out, 'results.tsv'), 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
const engines = rows.map(([engine, verdict, step]) => ({ engine, server: engine === 'mysql8' ? mysql8 : mariadb, verdict, failedStep: verdict === 'PASS' ? null : step, logs: ['deploy', 'diff', 'status', 'redeploy'].map((s) => `${engine}-${s}.log`).filter((f) => fs.existsSync(path.join(out, f))) }));
fs.writeFileSync(path.join(out, 'migrate-diff.json'), JSON.stringify({ image, engines, verdict: engines.length === 2 && engines.every((e) => e.verdict === 'PASS') ? 'PASS' : 'FAIL' }, null, 2) + '\n');
NODE

if [ "$failed" = 0 ]; then
  echo "Migrations of $IMAGE: deploy, diff, status and redeploy clean on MySQL 8 and MariaDB"
else
  echo "Migrations of $IMAGE: FAILED (see $OUT)" >&2
  exit 1
fi
