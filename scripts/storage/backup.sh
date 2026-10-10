#!/usr/bin/env bash
# Documents backup (roadmap 9.3): one compressed archive of the storage root
# (billing evidence, captured bills, statements, customer files: STORAGE_ROOT)
# and, when given, the product images directory (uploads/media, the files
# MediaStorage.cdnUrl rows point at), written atomically next to a SHA-256
# sidecar for the archive and a manifest with the SHA-256 of every file, then
# the oldest archives pruned. Runs wherever GNU tar is: on the host, in CI,
# or in the compose stack (`docker compose --profile ops run --rm db-ops documents-backup`).
#
#   scripts/storage/backup.sh --root DIR [--media DIR] [--out DIR] [--keep N] [--label TEXT]
#
#   --root DIR    the storage root (default: $STORAGE_ROOT); archived under storage/
#   --media DIR   the product images directory (default: $MEDIA_DIR, else none); archived under media/
#                 (a directory that does not exist yet, before the first upload, is noted and skipped)
#   --out DIR     where to write (default: $DOCUMENTS_BACKUP_DIR, else $BACKUP_DIR/documents,
#                 else /var/backups/dukaanai/documents)
#   --keep N      archives to keep in DIR, oldest removed first (default: $DOCUMENTS_BACKUP_KEEP, else 14; 0 = keep all)
#   --label TEXT  appended to the file name
#
# Evidence files are written once and never replaced (roadmap 7.5), so an
# archive taken while the API runs is consistent; a file that changes while
# tar reads it fails the run (nothing is kept) and the next run succeeds. The
# manifest (`<name>.manifest`, `sha256sum` format with storage/... and
# media/... paths) is what restore.sh verifies every restored file against.
# Records the success in BACKUP_STATUS_DIR (roadmap 9.4). Prints the archive path last.
set -euo pipefail
. "$(dirname "$0")/../db/lib.sh"

ROOT="${STORAGE_ROOT:-}"
MEDIA="${MEDIA_DIR:-}"
OUT="${DOCUMENTS_BACKUP_DIR:-${BACKUP_DIR:-/var/backups/dukaanai}/documents}"
KEEP="${DOCUMENTS_BACKUP_KEEP:-14}"
LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --media) MEDIA="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$ROOT" ] || die "no storage root: pass --root DIR or set STORAGE_ROOT"
[ -d "$ROOT" ] || die "storage root is not a directory: $ROOT"
if [ -n "$MEDIA" ] && [ ! -d "$MEDIA" ]; then
  # uploads/media appears with the first product image; until then there is nothing to archive.
  printf 'NOTE: media directory %s does not exist yet (no product image uploaded so far): archiving the storage root only\n' "$MEDIA" >&2
  MEDIA=""
fi
case "$KEEP" in *[!0-9]*|"") die "--keep must be a whole number (got '$KEEP')" ;; esac
case "$LABEL" in *[!A-Za-z0-9._-]*) die "--label may only contain letters, digits, dot, underscore and dash" ;; esac
command -v tar >/dev/null 2>&1 || die "tar not found"
tar --version 2>/dev/null | grep -q "GNU tar" || die "GNU tar is required (--dereference, --sort)"
mkdir -p "$OUT" 2>/dev/null || die "cannot create $OUT (pass --out DIR or set DOCUMENTS_BACKUP_DIR)"
[ -w "$OUT" ] || die "$OUT is not writable (pass --out DIR or set DOCUMENTS_BACKUP_DIR)"

taken_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="${taken_at//[-:]/}"
name="documents-${stamp}${LABEL:+-$LABEL}.tar.gz"
target="$OUT/$name"
partial="$OUT/.$name.partial"
# A staging directory of symlinks gives the archive its two top-level
# folders (storage/, media/) whatever the real paths are; -h follows them.
stage="$(mktemp -d)"
trap 'rm -f "$partial" "$OUT/.$name.manifest.partial"; rm -rf "$stage"' EXIT
ln -s "$(cd "$ROOT" && pwd -P)" "$stage/storage"
members=(storage)
if [ -n "$MEDIA" ]; then
  ln -s "$(cd "$MEDIA" && pwd -P)" "$stage/media"
  members+=(media)
fi

step "Archiving documents: storage root $ROOT${MEDIA:+, media $MEDIA} to $target"
# The manifest first, from the same tree the archive is taken from.
( cd "$stage" && find -L "${members[@]}" -type f -print0 | sort -z | xargs -0 -r sha256sum ) > "$OUT/.$name.manifest.partial"
files="$(wc -l < "$OUT/.$name.manifest.partial" | tr -d ' ')"
if ! tar --create --gzip --dereference --sort=name --file "$partial" -C "$stage" "${members[@]}"; then
  die "tar failed (a file changed while it was read, or a path is unreadable): nothing kept"
fi
gzip -t "$partial" || die "the archive is not a valid gzip file: nothing kept"
mv "$partial" "$target"
mv "$OUT/.$name.manifest.partial" "$target.manifest"
( cd "$OUT" && sha256sum "$name" > "$name.sha256" )
{
  printf 'storage_root=%s\n' "$ROOT"
  printf 'media_dir=%s\n' "$MEDIA"
  printf 'taken_at=%s\n' "$taken_at"
  printf 'files=%s\n' "$files"
} > "$target.meta"
trap - EXIT
rm -rf "$stage"

if [ "$KEEP" -gt 0 ]; then
  ls -1 "$OUT"/documents-*.tar.gz 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
    step "Pruning $(basename "$old")"
    rm -f "$old" "$old.sha256" "$old.manifest" "$old.meta"
  done
fi

size="$(du -h "$target" | cut -f1)"
record_success documents "$target ($files files)"
[ "$files" -gt 0 ] || printf 'NOTE: the storage root%s holds no file yet; the archive is empty\n' "${MEDIA:+ and media directory}" >&2
step "Documents backup written: $target ($size, $files files; .sha256, .manifest and .meta sidecars; taken at $taken_at)"
printf '%s\n' "$target"
