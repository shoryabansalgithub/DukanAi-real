#!/usr/bin/env bash
# The smoke against a DEPLOYED environment behind its edge (roadmap 9.9):
# staging after every promotion, production after a release.
#
#   bash scripts/smoke-remote.sh https://staging-app.example.com https://staging-api.example.com
#   bash scripts/smoke-remote.sh https://app.example.com https://api.example.com --probes-only
#
# Checks: both hostnames resolve; HTTP redirects to HTTPS; HTTPS answers with
# HSTS and no Server header; the API readiness and the web liveness routes;
# /api/metrics does not exist from here; then, unless --probes-only, the
# whole business flow of scripts/smoke-flow.mjs (registration of a fresh
# shop, API and web sign-in, stock, shift, a sale, the dashboard figure, a
# CLEAN reconciliation). The flow creates a shop and a sale on the target:
# run it on staging; on production use --probes-only.
#
#   --probes-only     no registration, no sale
#   --cacert FILE     trust this CA (an edge with `tls internal`)
#   --timeout SEC     per request (default 20)
#   --http-port PORT  the edge's plain HTTP port when it is not 80 (the
#                     redirect check otherwise speaks HTTP to the origin's
#                     port, which is the HTTPS one on a non-default edge)
set -euo pipefail
cd "$(dirname "$0")/.."

WEB=""; API=""; PROBES_ONLY=0; CACERT=""; TIMEOUT=20; HTTP_PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --probes-only) PROBES_ONLY=1; shift ;;
    --cacert) CACERT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    *) if [ -z "$WEB" ]; then WEB="${1%/}"; elif [ -z "$API" ]; then API="${1%/}"; else printf 'unexpected argument: %s\n' "$1" >&2; exit 2; fi; shift ;;
  esac
done
[ -n "$WEB" ] && [ -n "$API" ] || { printf 'usage: smoke-remote.sh <web-origin> <api-origin> [--probes-only] [--cacert FILE]\n' >&2; exit 2; }
case "$WEB$API" in *http://*) printf 'both origins must be https:// (the edge terminates TLS)\n' >&2; exit 2 ;; esac

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nREMOTE SMOKE FAILED: %s\n' "$*" >&2; exit 1; }
CURL=(curl -sS --max-time "$TIMEOUT" ${CACERT:+--cacert "$CACERT"})
host_of() { printf '%s' "$1" | sed -E 's#^https?://##; s#[:/].*$##'; }
WEB_HOST="$(host_of "$WEB")"; API_HOST="$(host_of "$API")"

step "the hostnames resolve: $WEB_HOST, $API_HOST"
for h in "$WEB_HOST" "$API_HOST"; do getent hosts "$h" >/dev/null 2>&1 || fail "$h does not resolve"; done

step "HTTP is redirected to HTTPS on both hosts"
for origin in "$WEB" "$API"; do
  http="http://${origin#https://}"
  [ -n "$HTTP_PORT" ] && http="http://$(host_of "$origin"):$HTTP_PORT"
  out="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code} %{redirect_url}' "$http/" || true)"
  case "$out" in 30[18]\ https://*) printf '  %s -> %s\n' "$http" "${out#* }" ;; *) fail "$http answered '$out', expected a redirect to https" ;; esac
done

step "HTTPS: readiness, liveness, HSTS, no Server header, scrape endpoint hidden"
ready="$("${CURL[@]}" -w '\n%{http_code}' "$API/api/health/ready")" || fail "GET $API/api/health/ready failed"
code="${ready##*$'\n'}"; body="${ready%$'\n'*}"
[ "$code" = "200" ] || fail "API readiness answered $code: $body"
grep -q '"status":"ok"\|"status": "ok"\|"up"' <<<"$body" || { printf '%s\n' "$body"; fail "readiness body does not report ok"; }
"${CURL[@]}" -o /dev/null -f "$WEB/api/health" || fail "the web liveness route failed"
headers="$("${CURL[@]}" -D - -o /dev/null "$API/api/health")"
grep -qi '^strict-transport-security:' <<<"$headers" || fail "no HSTS header on the API"
grep -qi '^server:' <<<"$headers" && fail "the Server header is exposed on the API"
metrics_code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$API/api/metrics")"
[ "$metrics_code" = "404" ] || fail "GET $API/api/metrics answered $metrics_code from outside, expected 404"
printf '  ready 200, web live, HSTS present, Server hidden, /api/metrics 404\n'

if [ "$PROBES_ONLY" = "1" ]; then
  printf '\nREMOTE SMOKE PASSED (probes only): %s and %s are up behind the edge.\n' "$WEB" "$API"
  exit 0
fi

step "the business flow over HTTPS (scripts/smoke-flow.mjs): registration, API and web sign-in, stock, shift, sale, dashboard, reconciliation"
flow="$(env ${CACERT:+NODE_EXTRA_CA_CERTS="$CACERT"} SMOKE_API_URL="$API/api" SMOKE_WEB_URL="$WEB" node scripts/smoke-flow.mjs 2>&1)" || { printf '%s\n' "$flow"; fail "smoke flow"; }
printf '%s\n' "$flow"
grep -q "completed" <<<"$flow" || fail "the smoke flow printed no completed sale"
printf '\nREMOTE SMOKE PASSED: sign-in and a sale through the edge at %s / %s.\n' "$WEB" "$API"
