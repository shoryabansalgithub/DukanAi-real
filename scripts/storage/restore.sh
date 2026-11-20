#!/usr/bin/env bash
# Restore a documents archive made by scripts/storage/backup.sh (roadmap 9.3).
#
#   scripts/storage/restore.sh ARCHIVE.tar.gz --to DIR [--yes] [--overwrite]
#   scripts/storage/restore.sh ARCHIVE.tar.gz --root DIR [--media DIR] [--yes] [--overwrite]
#
#   --to DIR      extract the whole archive into DIR (storage/ and media/ subtrees): a
#                 drill, a staging area, or a new volume to mount afterwards
#   --root DIR    extract the storage/ subtree into DIR (the STORAGE_ROOT volume) ...
#   --media DIR   ... and the media/ subtree into DIR (uploads/media)
#   --yes         actually restore; without it the plan is printed and nothing changes
#   --overwrite   allow a destination that is not empty: files in the archive replace
#                 files of the same name, everything else stays
#
# The .sha256 sidecar is verified before anything is written and every
# restored file is verified against the .manifest afterwards (a missing or
# altered file fails the restore), so a passing restore is byte-identical to
# what was archived. Destinations must be empty unless --overwrite is given:
# evidence is written once and never replaced, and a restore over a live
# volume is a deliberate act.
set -euo pipefail
. "$(dirname "$0")/../db/lib.sh"

[ $# -ge 1 ] || { sed -n '2,20p' "$0"; exit 2; }
ARCHIVE="$1"; shift
TO=""; ROOT=""; MEDIA=""; YES=0; OVERWRITE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --media) MEDIA="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --overwrite) OVERWRITE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd -P)/$(basename "$ARCHIVE")"
[ -f "$ARCHIVE.manifest" ] || die "no $(basename "$ARCHIVE").manifest next to the archive (not made by scripts/storage/backup.sh?)"
if [ -n "$TO" ]; then
  [ -z "$ROOT" ] && [ -z "$MEDIA" ] || die "--to cannot be combined with --root / --media"
else
  [ -n "$ROOT" ] || die "pass --to DIR, or --root DIR (and --media DIR)"
fi
command -v tar >/dev/null 2>&1 || die "tar not found"

step "Verifying $(basename "$ARCHIVE").sha256"
if [ -f "$ARCHIVE.sha256" ]; then
  ( cd "$(dirname "$ARCHIVE")" && sha256sum -c --quiet "$(basename "$ARCHIVE").sha256" ) || die "checksum mismatch: the archive is damaged or was altered"
else
  printf 'WARNING: no %s.sha256 next to the archive; the archive itself is not verified (every restored file still is)\n' "$(basename "$ARCHIVE")" >&2
fi
gzip -t "$ARCHIVE" || die "not a valid gzip file: $ARCHIVE"

files="$(wc -l < "$ARCHIVE.manifest" | tr -d ' ')"
storage_files="$(grep -c '  storage/' "$ARCHIVE.manifest" || true)"
media_files="$(grep -c '  media/' "$ARCHIVE.manifest" || true)"
taken_at="$(meta_get "$ARCHIVE" taken_at)"
if [ -n "$TO" ]; then
  step "Plan: restore $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1), $files files${taken_at:+, taken $taken_at}) into $TO (storage/: $storage_files files, media/: $media_files files)"
else
  step "Plan: restore $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1), $files files${taken_at:+, taken $taken_at}): storage/ ($storage_files files) into $ROOT${MEDIA:+, media/ ($media_files files) into $MEDIA}"
  [ -n "$MEDIA" ] || [ "$media_files" = 0 ] || printf 'NOTE: the archive holds %s media files and no --media DIR was given: they are not restored\n' "$media_files" >&2
fi

# A destination must be empty unless --overwrite says otherwise.
assert_destination() {
  local dir="$1"
  if [ -e "$dir" ]; then
    [ -d "$dir" ] || die "$dir exists and is not a directory"
    if [ "$OVERWRITE" != 1 ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
      die "$dir is not empty: restore into an empty directory, or pass --overwrite to replace same-named files in place"
    fi
  fi
}
if [ -n "$TO" ]; then assert_destination "$TO"; else assert_destination "$ROOT"; [ -z "$MEDIA" ] || assert_destination "$MEDIA"; fi

if [ "$YES" != 1 ]; then
  printf 'Dry run: pass --yes to restore.\n'
  exit 0
fi

started="$(date +%s)"
if [ -n "$TO" ]; then
  step "Extracting into $TO"
  mkdir -p "$TO"
  tar --extract --gzip --file "$ARCHIVE" -C "$TO" || die "extraction failed: $TO holds whatever was written before the error"
  step "Verifying every restored file against the manifest"
  ( cd "$TO" && sha256sum -c --quiet "$ARCHIVE.manifest" ) || die "a restored file is missing or differs from the manifest"
else
  step "Extracting storage/ into $ROOT${MEDIA:+ and media/ into $MEDIA}"
  mkdir -p "$ROOT"
  tar --extract --gzip --file "$ARCHIVE" -C "$ROOT" --strip-components=1 storage || die "extraction of storage/ failed: $ROOT holds whatever was written before the error"
  if [ -n "$MEDIA" ] && [ "$media_files" -gt 0 ]; then
    mkdir -p "$MEDIA"
    tar --extract --gzip --file "$ARCHIVE" -C "$MEDIA" --strip-components=1 media || die "extraction of media/ failed: $MEDIA holds whatever was written before the error"
  fi
  step "Verifying every restored file against the manifest"
  # The manifest names storage/... and media/...; map each onto its destination.
  while read -r sum path; do
    [ -n "$sum" ] || continue
    case "$path" in
      storage/*) printf '%s  %s\n' "$sum" "$ROOT/${path#storage/}" ;;
      media/*) [ -n "$MEDIA" ] && printf '%s  %s\n' "$sum" "$MEDIA/${path#media/}" ;;
      *) die "unexpected manifest path: $path" ;;
    esac
  done < "$ARCHIVE.manifest" | sha256sum -c --quiet || die "a restored file is missing or differs from the manifest"
fi
elapsed=$(( $(date +%s) - started ))
step "Restored $files files, every checksum identical to the manifest, in ${elapsed}s"
