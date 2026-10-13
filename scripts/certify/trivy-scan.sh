#!/usr/bin/env bash
# Image vulnerability scanning and SBOM (roadmap 9.14). Trivy is installed from
# its GitHub release, pinned by sha256 (no third-party action, like the
# gitleaks step in CI); the version and digest live in this file alone.
#
# Modes:
#   trivy-scan.sh gate IMAGE [IMAGE...]
#       Fail (exit 1) if any image carries a HIGH or CRITICAL vulnerability
#       that HAS A FIX (--ignore-unfixed): those are the actionable ones a
#       release must not ship. A table is printed; TRIVY_REPORT_DIR, when set,
#       also keeps a JSON report per image.
#   trivy-scan.sh sbom IMAGE OUTFILE
#       Write a CycloneDX SBOM of IMAGE to OUTFILE (the release artefact).
#   trivy-scan.sh control [IMAGE]
#       Prove the scanner is not a no-op: scan a pinned known-vulnerable image
#       (default TRIVY_CONTROL_IMAGE) for HIGH/CRITICAL *without* --ignore-unfixed
#       and assert Trivy reports at least one. If Trivy comes back clean the
#       control FAILS, because then the gate above would pass anything.
#
# Needs docker (an image scan reads the image) and network for the first run
# (the Trivy binary and its vulnerability database). TRIVY_CACHE_DIR caches the
# database between calls.
set -uo pipefail

TRIVY_VERSION="0.75.0"
TRIVY_SHA256="c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f"
TRIVY_URL="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
# A pinned image known to carry fixable HIGH/CRITICAL vulnerabilities, used only
# by the control. Bump it (louder, not quieter) if Trivy ever reports it clean.
CONTROL_IMAGE="${TRIVY_CONTROL_IMAGE:-alpine:3.12.0}"
CACHE_DIR="${TRIVY_CACHE_DIR:-${TMPDIR:-/tmp}/trivy-cache}"

log() { printf '%s\n' "$*" >&2; }
die() { log "trivy-scan: $*"; exit 2; }

ensure_trivy() {
  if command -v trivy >/dev/null 2>&1; then TRIVY="$(command -v trivy)"; return; fi
  local dir="${TRIVY_HOME:-${TMPDIR:-/tmp}/trivy-${TRIVY_VERSION}}"
  TRIVY="$dir/trivy"
  [ -x "$TRIVY" ] && return
  mkdir -p "$dir"
  log "downloading Trivy ${TRIVY_VERSION}"
  curl -fsSL -o "$dir/trivy.tgz" "$TRIVY_URL" || die "could not download Trivy"
  echo "${TRIVY_SHA256}  $dir/trivy.tgz" | sha256sum -c - >/dev/null 2>&1 || die "Trivy checksum mismatch (supply-chain guard)"
  tar -xzf "$dir/trivy.tgz" -C "$dir" trivy || die "could not extract Trivy"
}

MODE="${1:-}"; shift || true
ensure_trivy
mkdir -p "$CACHE_DIR"

case "$MODE" in
  gate)
    [ "$#" -ge 1 ] || die "usage: trivy-scan.sh gate IMAGE [IMAGE...]"
    command -v docker >/dev/null 2>&1 || die "docker is required to scan an image"
    failed=0
    for image in "$@"; do
      log "== scanning $image for fixable HIGH/CRITICAL vulnerabilities"
      report=()
      if [ -n "${TRIVY_REPORT_DIR:-}" ]; then
        mkdir -p "$TRIVY_REPORT_DIR"
        safe="$(printf '%s' "$image" | tr '/:@' '___')"
        report=(--format json --output "$TRIVY_REPORT_DIR/trivy-${safe}.json")
        "$TRIVY" image --quiet --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --cache-dir "$CACHE_DIR" "${report[@]}" "$image" || true
      fi
      # The table to the log, and the exit code is the gate.
      "$TRIVY" image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --cache-dir "$CACHE_DIR" "$image" || { failed=1; log "   $image has a fixable HIGH/CRITICAL vulnerability"; }
    done
    [ "$failed" = 0 ] || exit 1
    log "No fixable HIGH/CRITICAL vulnerability in any scanned image."
    ;;

  sbom)
    [ "$#" -eq 2 ] || die "usage: trivy-scan.sh sbom IMAGE OUTFILE"
    command -v docker >/dev/null 2>&1 || die "docker is required to scan an image"
    "$TRIVY" image --quiet --format cyclonedx --output "$2" --cache-dir "$CACHE_DIR" "$1" || die "could not write the SBOM for $1"
    log "SBOM (CycloneDX) for $1 -> $2"
    ;;

  control)
    image="${1:-$CONTROL_IMAGE}"
    command -v docker >/dev/null 2>&1 || die "docker is required to scan an image"
    log "== control: scanning the known-vulnerable $image (the gate must not be a no-op)"
    # Not --ignore-unfixed here: the control proves detection, not the ship policy.
    "$TRIVY" image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --cache-dir "$CACHE_DIR" "$image"
    rc=$?
    if [ "$rc" -eq 1 ]; then
      log "control passed: Trivy flagged $image, so the gate detects HIGH/CRITICAL vulnerabilities."
      exit 0
    fi
    log "control FAILED: Trivy reported $image clean (exit $rc); the vulnerability gate would pass anything. Bump TRIVY_CONTROL_IMAGE."
    exit 1
    ;;

  *)
    die "usage: trivy-scan.sh gate|sbom|control ..."
    ;;
esac
