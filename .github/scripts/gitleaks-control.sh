#!/usr/bin/env bash
# The secret scan is not a no-op (audit 2026-10-11, P1-13): gitleaks, run
# with the repository's .gitleaks.toml exactly as the lint job runs it, must
# report secrets planted in the files the allowlists name. A scratch copy of
# HEAD gets a GitHub token in a committed environment template, in a unit
# spec, in an integration test and in the password-policy denylist, and a
# generic API key in a spec file; every one must be reported, so an allowlist
# that matches on the path alone (or skips the file) fails the build.
#
#   .github/scripts/gitleaks-control.sh /path/to/gitleaks [config]
# config defaults to the working tree's .gitleaks.toml (the one under review).
set -euo pipefail
GITLEAKS="${1:?usage: gitleaks-control.sh /path/to/gitleaks [config]}"
CONFIG="${2:-}"
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
copy="$work/tree"
mkdir -p "$copy"
git -C "$root" archive HEAD | tar -x -C "$copy"
# The scan reads the working tree's config (the one under review), not HEAD's.
cp "${CONFIG:-$root/.gitleaks.toml}" "$copy/.gitleaks.toml"

# Fresh values every run: a fixed fake token would itself be a finding.
token="ghp_$(openssl rand -hex 18)"
generic="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-40)"
printf '\nGITHUB_TOKEN=%s\n' "$token" >> "$copy/apps/api/.env.production"
printf "\nexport const plantedToken = '%s';\nexport const api_key = '%s';\n" "$token" "$generic" > "$copy/apps/api/src/gitleaks-control.spec.ts"
printf "\nexport const plantedToken = '%s';\n" "$token" > "$copy/apps/api/test/gitleaks-control.ts"
printf "\nexport const plantedToken = '%s';\n" "$token" >> "$copy/apps/api/src/auth/password-policy.ts"

report="$work/report.json"
# Exactly the lint job's invocation, from the copy's root (allowlist paths are relative).
(cd "$copy" && "$GITLEAKS" dir . --no-banner --redact --config .gitleaks.toml --report-format json --report-path "$report" --exit-code 0 >/dev/null 2>&1)

expected=(
  "github-pat apps/api/.env.production"
  "github-pat apps/api/src/gitleaks-control.spec.ts"
  "github-pat apps/api/test/gitleaks-control.ts"
  "github-pat apps/api/src/auth/password-policy.ts"
  "generic-api-key apps/api/src/gitleaks-control.spec.ts"
)
found="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r.map((f)=>`${f.RuleID} ${f.File.replace(/^\.\//,"")}`).join("\n"))' "$report")"
status=0
for want in "${expected[@]}"; do
  if grep -Fxq "$want" <<<"$found"; then
    echo "gitleaks control: reported ${want}"
  else
    echo "::error::gitleaks did not report the planted secret (${want}): an allowlist in .gitleaks.toml hides real secrets in that file" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "gitleaks control: every planted secret was reported"
exit "$status"
