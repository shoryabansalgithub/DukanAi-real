#!/usr/bin/env bash
# Memory sampler of deploy/azure/e2e.sh: runs in a container with the host's
# cgroup tree at /cg (read-only) and the host's PID namespace, and every
# INTERVAL seconds appends one line per container to OUT:
#   <unix time> <name> <anon bytes> <file bytes> <swap bytes>
# plus one "<unix time> docker-daemons <rss bytes> 0 0" line for dockerd,
# containerd and the shims, until the file STOP exists.
#
#   memory-sampler.sh OUT STOP INTERVAL name=<container id> ...
set -euo pipefail
out="$1" stop="$2" interval="$3"; shift 3
declare -A dirs=()
for pair in "$@"; do
  name="${pair%%=*}" id="${pair#*=}"
  for d in "/cg/system.slice/docker-$id.scope" "/cg/docker/$id"; do
    [ -d "$d" ] && dirs[$name]="$d"
  done
  [ -n "${dirs[$name]:-}" ] || { echo "memory-sampler: no cgroup for $name ($id)" >&2; exit 1; }
done
while [ ! -e "$stop" ]; do
  now="$(date +%s)"
  for name in "${!dirs[@]}"; do
    d="${dirs[$name]}"
    [ -d "$d" ] || continue
    awk -v t="$now" -v n="$name" -v swap="$(cat "$d/memory.swap.current" 2>/dev/null || echo 0)" \
      '$1 == "anon" { a = $2 } $1 == "file" { f = $2 } END { print t, n, a + 0, f + 0, swap }' "$d/memory.stat" >> "$out" 2>/dev/null || true
  done
  rss=0
  for p in /proc/[0-9]*; do
    case "$(cat "$p/comm" 2>/dev/null)" in
      dockerd|containerd|containerd-shim*)
        v="$(awk '/^VmRSS:/ { print $2 * 1024 }' "$p/status" 2>/dev/null || true)"
        rss=$(( rss + ${v:-0} )) ;;
    esac
  done
  echo "$now docker-daemons $rss 0 0" >> "$out"
  sleep "$interval"
done
