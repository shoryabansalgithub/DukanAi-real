#!/bin/sh
# Writes what differs per deployment for deploy/prometheus/prometheus.yml
# from the environment, then (with --exec) starts Prometheus on it: the
# compose entrypoint of the prometheus service (deploy/observability/
# compose.yml). POSIX sh only: it runs inside the prom/prometheus image
# (busybox). Audit 2026-10-11, R11 / R12: nothing in the repository is edited
# per deployment.
#
#   render.sh [--dir DIR] [--exec] [-- PROMETHEUS_ARGS...]
#     --dir   where to write (default /run/dukaanai-prometheus, the path
#             prometheus.yml reads; a tmpfs in compose)
#     --exec  then exec Prometheus on /etc/prometheus/prometheus.yml with the
#             image's storage path, plus PROMETHEUS_ARGS
#
# Environment:
#   METRICS_TOKEN               the API's scrape token (blank = none)
#   PROMETHEUS_TOPOLOGY         reference (default) | production: which
#                               topology/<name>.rules.yml says the backup
#                               kinds the deployment runs
#   PROMETHEUS_PUBLIC_API_URL   the API as the internet reaches it
#                               (https://api.example.com/api); probed at
#                               <url>/health/ready and for its certificate
#   PROMETHEUS_PUBLIC_WEB_URL   the web app as the internet reaches it
#                               (https://app.example.com); probed at
#                               <url>/login and for its certificate
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR=/run/dukaanai-prometheus
EXEC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --exec) EXEC=1; shift ;;
    --) shift; break ;;
    *) echo "render.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

TOPOLOGY="${PROMETHEUS_TOPOLOGY:-reference}"
[ -f "$HERE/topology/$TOPOLOGY.rules.yml" ] || {
  echo "render.sh: PROMETHEUS_TOPOLOGY=$TOPOLOGY has no $HERE/topology/$TOPOLOGY.rules.yml (reference | production)" >&2; exit 2; }

# A public URL is an absolute http(s) URL without characters that would break
# the JSON written below.
url() {
  value="$2"
  [ -z "$value" ] && return 0
  case "$value" in
    *'"'*|*'\'*|*' '*) echo "render.sh: $1 must not contain quotes, backslashes or spaces" >&2; exit 2 ;;
    http://?*|https://?*) printf '%s' "${value%/}" ;;
    *) echo "render.sh: $1 must be an absolute http(s) URL (got '$value')" >&2; exit 2 ;;
  esac
}
API_URL="$(url PROMETHEUS_PUBLIC_API_URL "${PROMETHEUS_PUBLIC_API_URL:-}")"
WEB_URL="$(url PROMETHEUS_PUBLIC_WEB_URL "${PROMETHEUS_PUBLIC_WEB_URL:-}")"
READY=""; [ -n "$API_URL" ] && READY="$API_URL/health/ready"
LOGIN=""; [ -n "$WEB_URL" ] && LOGIN="$WEB_URL/login"

mkdir -p "$DIR/targets" "$DIR/rules"
# The token file always exists (empty when unset) so the scrape never names a
# missing file; only Prometheus's own user reads it.
(umask 077; printf '%s' "${METRICS_TOKEN:-}" > "$DIR/metrics-token")
cp "$HERE/topology/$TOPOLOGY.rules.yml" "$DIR/rules/topology.rules.yml"

# file_sd target list: [] when no address is given.
targets() {
  file="$1"; shift
  out=""; for t in "$@"; do [ -n "$t" ] && out="$out${out:+,}\"$t\""; done
  if [ -n "$out" ]; then printf '[{"targets":[%s]}]\n' "$out" > "$DIR/targets/$file"; else printf '[]\n' > "$DIR/targets/$file"; fi
}
targets public-ready.json "$READY"
targets public-login.json "$LOGIN"
targets public-tls.json "$READY" "$LOGIN"

token="none"; [ -n "${METRICS_TOKEN:-}" ] && token="bearer token from METRICS_TOKEN"
public="none (set PROMETHEUS_PUBLIC_API_URL / PROMETHEUS_PUBLIC_WEB_URL)"
[ -n "$READY$LOGIN" ] && public="$(echo "$READY $LOGIN" | sed 's/^ *//; s/ *$//')"
echo "render.sh: topology $TOPOLOGY; scrape token: $token; public probes: $public; wrote $DIR" >&2

if [ "$EXEC" = 1 ]; then
  exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus "$@"
fi
