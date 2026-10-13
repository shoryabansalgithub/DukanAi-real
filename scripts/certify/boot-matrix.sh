#!/usr/bin/env bash
# Boot matrix on the API image (roadmap 9.12): every refusal case of
# apps/api/test/boot-matrix.json (the file test/boot-regression.e2e-spec.ts
# runs against the built entrypoint) is booted from the image itself, and
# each must exit non-zero with "[Bootstrap FATAL]" and the reason naming the
# variable. Nothing is dialled: every case fails at configuration validation.
#
#   scripts/certify/boot-matrix.sh IMAGE OUT_DIR
#
# OUT_DIR receives case-<n>.log (the container's output), case-<n>.env (the
# environment it ran with) and boot-matrix.json (one row per case with the
# exit code and the two matches). Exit 1 when any case passed its
# configuration or printed the wrong reason.
set -uo pipefail
IMAGE="${1:?usage: boot-matrix.sh IMAGE OUT_DIR}"
OUT="${2:?usage: boot-matrix.sh IMAGE OUT_DIR}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MATRIX="$REPO/apps/api/test/boot-matrix.json"
mkdir -p "$OUT"
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }
[ -f "$MATRIX" ] || { echo "no boot matrix at $MATRIX" >&2; exit 2; }

# One env file per case (docker --env-file format) and a tab-separated index:
# <n> <label> <reason> <variables to unset, space separated>.
node - "$MATRIX" "$OUT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [matrixFile, out] = process.argv.slice(2);
const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
const index = [];
matrix.cases.forEach((c, i) => {
  const env = { ...matrix.validProduction, ...c.env };
  const unset = Object.entries(env).filter(([, v]) => v === null).map(([k]) => k);
  const lines = Object.entries(env).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(out, `case-${i + 1}.env`), lines.join('\n') + '\n');
  index.push([i + 1, c.label, c.reason, unset.join(' ')].join('\t'));
});
fs.writeFileSync(path.join(out, 'cases.tsv'), index.join('\n') + '\n');
fs.writeFileSync(path.join(out, 'fatal-marker.txt'), matrix.fatalMarker);
NODE

marker="$(cat "$OUT/fatal-marker.txt")"
failed=0
: > "$OUT/results.tsv"
while IFS=$'\t' read -r n label reason unset; do
  log="$OUT/case-$n.log"
  # The image bakes NODE_ENV=production in, so a variable the case leaves out
  # is unset inside the container before the entrypoint runs; the command is
  # the image's own CMD (node dist/main in its working directory).
  pre=""
  [ -n "$unset" ] && pre="unset $unset; "
  timeout 180 docker run --rm --env-file "$OUT/case-$n.env" "$IMAGE" sh -c "${pre}exec node dist/main" >"$log" 2>&1
  rc=$?
  marker_ok=0; reason_ok=0
  grep -Eq "$marker" "$log" && marker_ok=1
  grep -Eq "$reason" "$log" && reason_ok=1
  verdict=PASS
  if [ "$rc" = 0 ] || [ "$marker_ok" = 0 ] || [ "$reason_ok" = 0 ]; then verdict=FAIL; failed=1; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$label" "$rc" "$marker_ok" "$reason_ok" "$verdict" >> "$OUT/results.tsv"
  printf '%-4s %-40s exit %-3s marker %s reason %s  %s\n' "$n" "$label" "$rc" "$marker_ok" "$reason_ok" "$verdict"
done < "$OUT/cases.tsv"

node - "$OUT" "$IMAGE" <<'NODE'
const fs = require('fs');
const path = require('path');
const [out, image] = process.argv.slice(2);
const cases = fs.readFileSync(path.join(out, 'cases.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));
const results = fs.readFileSync(path.join(out, 'results.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));
const rows = results.map(([n, label, exitCode, markerOk, reasonOk, verdict]) => ({
  case: Number(n),
  label,
  reason: cases.find((c) => c[0] === n)?.[2],
  exitCode: Number(exitCode),
  fatalMarker: markerOk === '1',
  reasonMatched: reasonOk === '1',
  verdict,
  log: `case-${n}.log`,
}));
fs.writeFileSync(path.join(out, 'boot-matrix.json'), JSON.stringify({ image, cases: rows, verdict: rows.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL' }, null, 2) + '\n');
NODE

if [ "$failed" = 0 ]; then
  echo "Boot matrix on $IMAGE: every case refused to start with its reason"
else
  echo "Boot matrix on $IMAGE: FAILED (see $OUT/results.tsv and the case logs)" >&2
  exit 1
fi
