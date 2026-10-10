#!/usr/bin/env bash
# Phase 9 gate for rows 9.7 and 9.8: the production compose variant
# (docker-compose.prod.yml) brought up against an EXTERNAL database that
# accepts TLS only, with the edge terminating HTTPS, proves from scratch:
#   - the release step and the API connect over TLS with the server
#     certificate verified (?sslaccept=strict against a private CA);
#   - HTTP is redirected to HTTPS, HSTS is set, the Server header is gone;
#   - registration, API and web sign-in, stock, shift, a sale, the dashboard
#     and the reconciliation of the day work over HTTPS through the edge
#     (scripts/smoke-flow.mjs trusting Caddy's local CA);
#   - /api/metrics does not exist from outside and is served inside the
#     network;
#   - the API sees the client address: a client that exhausts the login
#     rate limit is answered 429 while a second client, even one claiming
#     the first one's address in X-Forwarded-For, is still answered 401;
#   - the backup agent dumps the external database (with its binary-log
#     position), archives the documents and the API exposes both stamps;
#   - the API stops gracefully.
# Needs docker (compose v2), curl, openssl and node. The throwaway MySQL and
# Redis come from scripts/smoke-prod/external-services.yml, layered over the
# production file for this run only. Hostnames app.localhost / api.localhost
# must resolve to 127.0.0.1 (systemd-resolved does; otherwise the script
# adds them to /etc/hosts with sudo). Ports 80 and 443 must be free
# (EDGE_HTTP_PORT / EDGE_HTTPS_PORT move them; the redirect check then only
# looks at the scheme).
#
#   bash scripts/compose-smoke-prod.sh            # builds, proves, tears down
#   KEEP=1 bash scripts/compose-smoke-prod.sh     # leaves the stack running
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

KEEP="${KEEP:-0}"
HTTP_PORT="${EDGE_HTTP_PORT:-80}"
HTTPS_PORT="${EDGE_HTTPS_PORT:-443}"
WEB_HOST=app.localhost
API_HOST=api.localhost
port_suffix() { [ "$1" = "$2" ] && printf '' || printf ':%s' "$1"; }
WEB_ORIGIN="https://${WEB_HOST}$(port_suffix "$HTTPS_PORT" 443)"
API_ORIGIN="https://${API_HOST}$(port_suffix "$HTTPS_PORT" 443)"
API="${API_ORIGIN}/api"
PROJECT=dukaanai-prod
WORK="$(mktemp -d)"
# docker-compose.build.yml builds the images from this checkout (a server
# pulls the release tag instead); the web image gets no build-time API URL,
# so the flow below also proves the runtime API_PUBLIC_URL (roadmap 9.9).
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.prod.yml -f docker-compose.build.yml -f scripts/smoke-prod/external-services.yml --env-file "$WORK/.env")
CURL_IMAGE=curlimages/curl:8.16.0

step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nPROD SMOKE FAILED: %s\n' "$*" >&2
  "${COMPOSE[@]}" ps -a >&2 || true
  "${COMPOSE[@]}" logs --no-color --tail=80 migrate api web edge backup-agent dukaanai-ext-mysql >&2 || true
  exit 1
}
cleanup() {
  if [ "$KEEP" = "1" ]; then printf '\nKEEP=1: stack left running (%s, %s); env in %s\n' "$WEB_ORIGIN" "$API" "$WORK"; return; fi
  step "docker compose down -v (project $PROJECT)"
  docker rm -f smoke-client-a >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
gen() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-32}).toString('hex'))"; }

step "the hostnames $WEB_HOST and $API_HOST resolve to this machine"
for h in "$WEB_HOST" "$API_HOST"; do
  if ! getent hosts "$h" >/dev/null 2>&1; then
    printf '  %s does not resolve: adding it to /etc/hosts\n' "$h"
    printf '127.0.0.1 %s\n' "$h" | sudo -n tee -a /etc/hosts >/dev/null || fail "$h does not resolve and /etc/hosts is not writable"
  fi
done

step "a private CA and a server certificate for the external MySQL (the API must verify it)"
mkdir -p "$WORK/certs"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -subj "/CN=DukaanAI smoke CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$WORK/certs/ca.key" -out "$WORK/certs/ca.pem" >/dev/null 2>&1 || fail "openssl: CA"
openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=dukaanai-ext-mysql" \
  -keyout "$WORK/certs/server.key" -out "$WORK/certs/server.csr" >/dev/null 2>&1 || fail "openssl: server key"
printf 'subjectAltName=DNS:dukaanai-ext-mysql\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$WORK/certs/server.ext"
openssl x509 -req -sha256 -days 2 -in "$WORK/certs/server.csr" -CA "$WORK/certs/ca.pem" -CAkey "$WORK/certs/ca.key" \
  -CAcreateserial -extfile "$WORK/certs/server.ext" -out "$WORK/certs/server.pem" >/dev/null 2>&1 || fail "openssl: server certificate"
# mysqld runs as the image's mysql user: it must be able to read the key.
chmod 755 "$WORK" "$WORK/certs"; chmod 644 "$WORK"/certs/*

step "the operator's .env for docker-compose.prod.yml (external TLS DATABASE_URL, REDIS_URL, hosts, secrets)"
DB_PW="$(gen 12)"; DB_ROOT_PW="$(gen 12)"
cat > "$WORK/.env" <<ENV
IMAGE_REGISTRY=dukaanai-smoke
IMAGE_TAG=smoke
DATABASE_URL=mysql://dukaanai:${DB_PW}@dukaanai-ext-mysql:3306/dukaanai?connection_limit=20&sslaccept=strict&sslcert=/etc/dukaanai/db-ca.pem
DB_CA_FILE=${WORK}/certs/ca.pem
REDIS_URL=redis://dukaanai-ext-redis:6379/0
JWT_SECRET=$(gen)
NEXTAUTH_SECRET=$(gen)
WEB_HOST=${WEB_HOST}
API_HOST=${API_HOST}
WEB_ORIGIN=${WEB_ORIGIN}
API_PUBLIC_URL=${API}
EDGE_TLS_LINE=tls internal
EDGE_HTTP_PORT=${HTTP_PORT}
EDGE_HTTPS_PORT=${HTTPS_PORT}
TRUST_PROXY=1
DB_OPS_DATABASE_URL=mysql://root:${DB_ROOT_PW}@dukaanai-ext-mysql:3306/dukaanai
SMOKE_DB_PASSWORD=${DB_PW}
SMOKE_DB_ROOT_PASSWORD=${DB_ROOT_PW}
SMOKE_CERT_DIR=${WORK}/certs
ENV

step "docker compose -f docker-compose.prod.yml -f docker-compose.build.yml up --build -d --wait (external mysql + redis, migrate, api, web, edge, backup-agent)"
"${COMPOSE[@]}" up --build -d --wait --wait-timeout 900 || fail "the production stack did not reach a healthy state"
[ "$("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' migrate)" = "0" ] || fail "migrate did not exit 0"
# The web image carries the build-time default (http://localhost:3002/api);
# the browser-facing URL must come from API_PUBLIC_URL at run time.
meta="$("${COMPOSE[@]}" exec -T web node -e "fetch('http://127.0.0.1:3000/login').then((r) => r.text()).then((t) => { const m = /<meta name=\"dukaanai-api-url\" content=\"([^\"]+)\"/.exec(t); process.stdout.write(m ? m[1] : 'MISSING'); })" 2>/dev/null || true)"
[ "$meta" = "$API" ] || fail "the web serves the API URL '$meta' in <meta name=dukaanai-api-url>, expected the runtime API_PUBLIC_URL $API"
printf '  the web image was built without an API URL and serves %s from API_PUBLIC_URL at run time\n' "$meta"
printf '  migrate and the API connected to dukaanai-ext-mysql, which refuses plaintext (require_secure_transport=ON), with the certificate verified against the private CA\n'

step "the edge issued certificates from its local CA; exporting the root for the clients"
for _ in $(seq 1 30); do "${COMPOSE[@]}" cp edge:/data/caddy/pki/authorities/local/root.crt "$WORK/caddy-root.crt" >/dev/null 2>&1 && break; sleep 1; done
[ -s "$WORK/caddy-root.crt" ] || fail "no Caddy root certificate after 30 s"
chmod 644 "$WORK/caddy-root.crt"
CURL=(curl -sS --cacert "$WORK/caddy-root.crt" --resolve "${WEB_HOST}:${HTTPS_PORT}:127.0.0.1" --resolve "${API_HOST}:${HTTPS_PORT}:127.0.0.1")

step "HTTP is redirected to HTTPS; HTTPS answers with HSTS and without a Server header"
redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "${WEB_HOST}:${HTTP_PORT}:127.0.0.1" "http://${WEB_HOST}$(port_suffix "$HTTP_PORT" 80)/login")"
case "$redirect" in
  "308 https://${WEB_HOST}"*|"301 https://${WEB_HOST}"*) printf '  %s\n' "$redirect" ;;
  *) fail "expected a redirect to https://${WEB_HOST}/..., got '$redirect'" ;;
esac
headers="$("${CURL[@]}" -D - -o /dev/null "${API}/health")"
grep -qi '^strict-transport-security:' <<<"$headers" || { printf '%s\n' "$headers"; fail "no HSTS header on the API over HTTPS"; }
grep -qi '^server:' <<<"$headers" && { printf '%s\n' "$headers"; fail "the Server header is exposed"; }
"${CURL[@]}" -o /dev/null -f "${WEB_ORIGIN}/api/health" || fail "the web liveness route is not served over HTTPS"

step "registration, API and web sign-in, stock, shift, sale, dashboard, reconciliation over HTTPS through the edge (scripts/smoke-flow.mjs)"
flow="$(NODE_EXTRA_CA_CERTS="$WORK/caddy-root.crt" SMOKE_API_URL="$API" SMOKE_WEB_URL="$WEB_ORIGIN" node scripts/smoke-flow.mjs 2>&1)" || { printf '%s\n' "$flow"; fail "smoke flow over HTTPS"; }
printf '%s\n' "$flow"
grep -q "completed" <<<"$flow" || fail "the smoke flow printed no completed sale"

step "/api/metrics does not exist through the edge and is served inside the network"
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${API}/metrics")"
[ "$code" = "404" ] || fail "GET /api/metrics through the edge answered $code, expected 404"
NET="${PROJECT}_default"
inside() { docker run --rm --network "$NET" -v "$WORK/caddy-root.crt:/ca/root.crt:ro" "$CURL_IMAGE" "$@"; }
metrics="$(inside -fsS http://api:3002/api/metrics)" || fail "GET http://api:3002/api/metrics from inside the network failed"
grep -q '^http_requests_total' <<<"$metrics" || fail "the internal scrape carries no http_requests_total"
printf '  404 from the internet, %s series inside\n' "$(grep -c '^[a-z]' <<<"$metrics")"

step "the API sees the client address (TRUST_PROXY=1 behind the edge): the login limit is per client, X-Forwarded-For from a client is ignored"
# Client A: 6 failed logins with distinct unknown accounts inside the short
# window (AUTH_RATE_LIMIT_SHORT_LIMIT = 5 per 10 s per address): the sixth
# is 429. It prints its own address first.
# Client A stays up until client B has run: Docker hands a released
# address to the next container on the network, which would give both
# clients the same address and the same counter.
docker rm -f smoke-client-a >/dev/null 2>&1 || true
docker run -d --name smoke-client-a --network "$NET" -v "$WORK/caddy-root.crt:/ca/root.crt:ro" --entrypoint sleep "$CURL_IMAGE" 600 >/dev/null || fail "client A container did not start"
a_out="$(docker exec smoke-client-a sh -c '
  ip="$(hostname -i 2>/dev/null | awk "{print \$1}")"; [ -n "$ip" ] || ip="$(awk -v h="$(hostname)" "\$2==h{ip=\$1} END{print ip}" /etc/hosts)"; echo "$ip"
  for i in 1 2 3 4 5 6; do
    curl -sS -o /dev/null -w "%{http_code}\n" --cacert /ca/root.crt --connect-to '"${API_HOST}:${HTTPS_PORT}:edge:443"' \
      -H "content-type: application/json" -d "{\"email\":\"nobody-$i-'"$(gen 4)"'@smoke.invalid\",\"password\":\"wrong-password\"}" '"${API}"'/auth/login
  done')" || fail "client A could not reach the API"
a_ip="$(printf '%s\n' "$a_out" | head -n 1)"
a_codes="$(printf '%s\n' "$a_out" | tail -n +2 | tr '\n' ' ')"
printf '  client A (%s): %s\n' "$a_ip" "$a_codes"
[ "$a_codes" = "401 401 401 401 401 429 " ] || fail "client A expected 401 x5 then 429, got: $a_codes"
# Client B claims A's address: Caddy discards a client-supplied
# X-Forwarded-For (no trusted_proxies), so the API counts B's own address.
b_out="$(docker run --rm --network "$NET" -v "$WORK/caddy-root.crt:/ca/root.crt:ro" --entrypoint sh "$CURL_IMAGE" -c '
  ip="$(hostname -i 2>/dev/null | awk "{print \$1}")"; [ -n "$ip" ] || ip="$(awk -v h="$(hostname)" "\$2==h{ip=\$1} END{print ip}" /etc/hosts)"; echo "$ip"
  curl -sS -o /dev/null -w "%{http_code}\n" --cacert /ca/root.crt --connect-to '"${API_HOST}:${HTTPS_PORT}:edge:443"' \
    -H "content-type: application/json" -H "X-Forwarded-For: '"$a_ip"'" -d "{\"email\":\"nobody-b-'"$(gen 4)"'@smoke.invalid\",\"password\":\"wrong-password\"}" '"${API}"'/auth/login')" || fail "client B could not reach the API"
b_ip="$(printf '%s\n' "$b_out" | head -n 1)"
b_code="$(printf '%s\n' "$b_out" | tail -n 1)"
printf '  client B (%s, X-Forwarded-For: %s): %s\n' "$b_ip" "$a_ip" "$b_code"
docker rm -f smoke-client-a >/dev/null 2>&1 || true
[ "$a_ip" != "$b_ip" ] || fail "the two clients share an address"
[ "$b_code" = "401" ] || fail "client B expected 401 (its own counter), got $b_code: the API did not see the client address"

step "the backup agent dumps the external database and archives the documents (backup-agent: backup-loop)"
for _ in $(seq 1 60); do
  logs="$("${COMPOSE[@]}" logs --no-color backup-agent 2>/dev/null || true)"
  grep -q "Documents backup written" <<<"$logs" && break
  sleep 2
done
grep -q "Backup written: " <<<"$logs" || { printf '%s\n' "$logs"; fail "the backup agent wrote no dump within 120 s"; }
grep -q "binary-log position " <<<"$logs" || { printf '%s\n' "$logs"; fail "the dump recorded no binary-log position"; }
grep -q "Documents backup written" <<<"$logs" || { printf '%s\n' "$logs"; fail "the backup agent wrote no documents archive within 120 s"; }
grep -q "OFFSITE_REMOTE is not set" <<<"$logs" || { printf '%s\n' "$logs"; fail "the agent did not report the missing off-site remote"; }
metrics="$(inside -fsS http://api:3002/api/metrics)" || fail "second internal scrape failed"
for kind in dump documents; do
  grep -Eq "^backup_last_success_timestamp_seconds\{kind=\"$kind\"[,}]" <<<"$metrics" || { grep backup_last <<<"$metrics" || true; fail "no backup_last_success_timestamp_seconds series for kind $kind"; }
done
printf '  dump with binary-log position and documents archive written; both stamps exposed by the API\n'

step "graceful stop: SIGTERM -> readiness 503 -> exit 0 (never SIGKILL)"
"${COMPOSE[@]}" stop -t 40 api
[ "$("${COMPOSE[@]}" ps -a --format '{{.ExitCode}}' api)" = "0" ] || fail "api did not exit 0 on SIGTERM"
api_log="$("${COMPOSE[@]}" logs --no-color api)" || fail "could not read the api log"
grep -q "Shutdown requested by SIGTERM" <<<"$api_log" || fail "api log has no shutdown line"
grep -q "Database connection closed" <<<"$api_log" || fail "api log has no Prisma close line"

printf '\nPROD SMOKE PASSED: the production variant ran against an external TLS-only MySQL with the certificate verified, HTTPS through the edge with HTTP redirected, sign-in and a sale over HTTPS, the scrape endpoint hidden, the rate limit counted per client address with a spoofed X-Forwarded-For ignored, the backup agent dumped the database and the documents, graceful stop verified.\n'
