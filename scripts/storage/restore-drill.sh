#!/usr/bin/env bash
# Documents restore drill (roadmap 9.3): proves that an archive made by
# scripts/storage/backup.sh restores every file byte for byte.
#
#   scripts/storage/restore-drill.sh --root DIR [--media DIR] [--keep]
#
# Steps: back the storage root (and media directory) up -> restore the
# archive into a fresh temporary directory -> every restored file matches
# the manifest -> every file of the source is present in the restore with the
# same SHA-256 and nothing else is (a fresh manifest of the source, compared
# to a fresh manifest of the restore) -> the temporary directory is removed
# (--keep leaves it). Run it against a quiet source (CI after the integration
# suites, on the evidence they wrote): a file written during the run makes
# the two manifests differ and the drill fails, which is the point.
set -euo pipefail
. "$(dirname "$0")/../db/lib.sh"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

ROOT="${STORAGE_ROOT:-}"
MEDIA="${MEDIA_DIR:-}"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --media) MEDIA="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$ROOT" ] || die "no storage root: pass --root DIR or set STORAGE_ROOT"
[ -d "$ROOT" ] || die "storage root is not a directory: $ROOT"

WORK="$(mktemp -d)"
started="$(date +%s)"
cleanup() {
  if [ "$KEEP" = 1 ]; then printf '\n--keep: archive and restore left in %s\n' "$WORK"; return; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step "1/4 Documents backup of $ROOT${MEDIA:+ and $MEDIA}"
archive="$(bash "$REPO/scripts/storage/backup.sh" --root "$ROOT" ${MEDIA:+--media "$MEDIA"} --out "$WORK/backup" --keep 0 --label drill | tail -n 1)"
[ -f "$archive" ] || die "backup.sh did not produce an archive"
files="$(wc -l < "$archive.manifest" | tr -d ' ')"
[ "$files" -gt 0 ] || die "the source holds no file: nothing to prove (write evidence first, or point --root at a populated storage root)"

step "2/4 Restore into $WORK/restore"
bash "$REPO/scripts/storage/restore.sh" "$archive" --to "$WORK/restore" --yes

step "3/4 Every source file is in the restore with the same SHA-256, and nothing else is"
stage="$WORK/stage"; mkdir -p "$stage"
ln -s "$(cd "$ROOT" && pwd -P)" "$stage/storage"
members=(storage)
if [ -n "$MEDIA" ]; then ln -s "$(cd "$MEDIA" && pwd -P)" "$stage/media"; members+=(media); fi
( cd "$stage" && find -L "${members[@]}" -type f -print0 | sort -z | xargs -0 -r sha256sum ) > "$WORK/source.sums"
( cd "$WORK/restore" && find "${members[@]}" -type f -print0 | sort -z | xargs -0 -r sha256sum ) > "$WORK/restore.sums"
if ! cmp -s "$WORK/source.sums" "$WORK/restore.sums"; then
  diff "$WORK/source.sums" "$WORK/restore.sums" | head -n 20
  die "the restore differs from the source (was a file written during the drill?)"
fi
bytes="$(cd "$WORK/restore" && find "${members[@]}" -type f -printf '%s\n' | awk '{ s += $1 } END { print s + 0 }')"
printf '  %s files, %s bytes, identical\n' "$files" "$bytes"

step "4/4 A single file restored from the archive is byte-identical"
sample="$(head -n 1 "$WORK/restore.sums" | sed 's/^[0-9a-f]*  //')"
cmp -s "$stage/$sample" "$WORK/restore/$sample" || die "$sample differs after restore"
printf '  %s: identical\n' "$sample"

elapsed=$(( $(date +%s) - started ))
printf '\nDOCUMENTS RESTORE DRILL PASSED: %s files / %s bytes from %s%s, archive %s, every checksum identical, %ss\n' \
  "$files" "$bytes" "$ROOT" "${MEDIA:+ and $MEDIA}" "$(du -h "$archive" | cut -f1)" "$elapsed"
