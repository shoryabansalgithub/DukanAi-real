#!/usr/bin/env bash
# Off-site restore drill (roadmap 9.4): proves that what offsite.sh ships can
# be brought back on a clean machine and restored, and that nothing readable
# sits in the bucket.
#
#   DATABASE_URL=mysql://root:...@host:3306/dukaanai OFFSITE_REMOTE=... OFFSITE_CRYPT_PASSWORD=... \
#     scripts/backup/offsite-drill.sh --root DIR [--media DIR] [--keep]
#
# Steps: a fresh local backup directory gets a dump (binary-log position
# included), the binary-log archive and a documents archive of --root ->
# offsite.sh push ships it -> the bucket holds only encrypted names and
# contents (no file name of the backups appears, and a dump's bytes are not
# in the bucket) -> a clean workspace fetches everything with offsite.sh
# fetch -> every .sha256 sidecar verifies -> the documents archive restores
# with every checksum identical -> the fetched dump restores into a scratch
# database (<db>_offsite_<stamp>) with the same migration count as the source
# -> scratch database and workspace removed (--keep leaves them). With
# OFFSITE_REMOTE=local:<dir> the drill needs no cloud account and exercises
# the same code path; CI runs it that way. Needs rclone, mysql, mysqldump and
# mysqlbinlog, node (prisma is not used), GNU tar.
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
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$ROOT" ] || die "no storage root: pass --root DIR or set STORAGE_ROOT"
[ -d "$ROOT" ] || die "storage root is not a directory: $ROOT"
[ -n "${OFFSITE_REMOTE:-}" ] || die "OFFSITE_REMOTE is not set (local:<dir> for a drill without a cloud account)"
[ -n "${OFFSITE_CRYPT_PASSWORD:-}" ] || die "OFFSITE_CRYPT_PASSWORD is not set"
command -v rclone >/dev/null 2>&1 || die "rclone not found"
export RCLONE_CONFIG_LOCAL_TYPE=local

load_connection
require_clients
require_binlog_client
assert_server

stamp="$(date -u +%Y%m%d%H%M%S)"
SCRATCH_DB="${DB_NAME}_offsite_${stamp}"
assert_identifier "$SCRATCH_DB"
WORK="$(mktemp -d)"
started="$(date +%s)"
cleanup() {
  if [ "$KEEP" = 1 ]; then printf '\n--keep: scratch database %s and workspace %s left in place\n' "$SCRATCH_DB" "$WORK"; return; fi
  "$MYSQL_BIN" $(conn_args) -e "DROP DATABASE IF EXISTS \`$SCRATCH_DB\`" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The drill ships its own fresh backup directory and its own status stamps,
# never the operator's.
export BACKUP_DIR="$WORK/backups" BACKUP_STATUS_DIR="$WORK/backups/status" BINLOG_ARCHIVE_DIR="$WORK/backups/binlog" DOCUMENTS_BACKUP_DIR="$WORK/backups/documents"
step "1/7 A fresh backup set: dump, binary-log archive, documents archive (in $BACKUP_DIR)"
dump="$(bash "$REPO/scripts/db/backup.sh" --out "$BACKUP_DIR" --keep 0 --label offsite-drill | tail -n 1)"
[ -f "$dump" ] || die "backup.sh produced no dump"
if binlog_enabled; then
  bash "$REPO/scripts/db/binlog-archive.sh" --out "$BINLOG_ARCHIVE_DIR" --flush --keep-days 0 >/dev/null
else
  printf '  (binary logging is off on the server: no binary-log archive in this set)\n'
fi
docs="$(bash "$REPO/scripts/storage/backup.sh" --root "$ROOT" ${MEDIA:+--media "$MEDIA"} --out "$DOCUMENTS_BACKUP_DIR" --keep 0 --label offsite-drill | tail -n 1)"
[ -f "$docs" ] || die "storage/backup.sh produced no archive"
local_files="$(find "$BACKUP_DIR" -type f ! -name '.*' | wc -l | tr -d ' ')"
printf '  %s files to ship\n' "$local_files"

step "2/7 Ship it: offsite.sh push to $OFFSITE_REMOTE"
bash "$REPO/scripts/backup/offsite.sh" push

step "3/7 The bucket holds nothing readable"
# What the remote looks like without the key: list the wrapped remote directly.
raw_listing="$(rclone lsf -R "$OFFSITE_REMOTE" 2>/dev/null || true)"
[ -n "$raw_listing" ] || die "the remote $OFFSITE_REMOTE lists nothing after the push"
for plain in "$(basename "$dump")" "$(basename "$docs")" "status" "binlog" "documents" ".sql.gz" ".tar.gz" ".sha256" ".last-success"; do
  if printf '%s\n' "$raw_listing" | grep -qF "$plain"; then die "the bucket shows a readable name: $plain"; fi
done
raw_count="$(printf '%s\n' "$raw_listing" | grep -vc '/$' || true)"
printf '  %s encrypted objects, no readable name among them\n' "$raw_count"
case "$OFFSITE_REMOTE" in
  local:*)
    bucket_dir="${OFFSITE_REMOTE#local:}"
    probe="$({ gzip -dc "$dump" 2>/dev/null || true; } | grep -m1 'CREATE TABLE' | cut -c1-40)"
    [ -n "$probe" ] || die "the dump holds no CREATE TABLE line to probe with"
    if grep -rqF -- "$probe" "$bucket_dir" 2>/dev/null; then die "a dump's content is readable in the bucket"; fi
    if grep -rqF -- "$(sed -n 1p "$docs.manifest" | cut -c1-40)" "$bucket_dir" 2>/dev/null; then die "a manifest's content is readable in the bucket"; fi
    printf '  the dump text and the manifest text are not in the bucket\n'
    ;;
esac

step "4/7 A clean machine: fetch everything into an empty workspace"
CLEAN="$WORK/clean"
bash "$REPO/scripts/backup/offsite.sh" fetch "$CLEAN"
fetched="$(find "$CLEAN" -type f | wc -l | tr -d ' ')"
[ "$fetched" = "$local_files" ] || die "fetched $fetched file(s), shipped $local_files"

step "5/7 Every fetched .sha256 sidecar verifies"
n=0
while IFS= read -r -d '' sidecar; do
  ( cd "$(dirname "$sidecar")" && sha256sum -c --quiet "$(basename "$sidecar")" ) || die "checksum mismatch after the round trip: $sidecar"
  n=$((n + 1))
done < <(find "$CLEAN" -type f -name '*.sha256' -print0)
[ "$n" -gt 0 ] || die "no .sha256 sidecar came back"
printf '  %s sidecars verified\n' "$n"

step "6/7 The fetched documents archive restores with every checksum identical"
fetched_docs="$CLEAN/documents/$(basename "$docs")"
[ -f "$fetched_docs" ] || die "the documents archive did not come back: $fetched_docs"
bash "$REPO/scripts/storage/restore.sh" "$fetched_docs" --to "$WORK/restore-docs" --yes | tail -n 1

step "7/7 The fetched dump restores into $SCRATCH_DB with the source's migration count"
fetched_dump="$CLEAN/$(basename "$dump")"
[ -f "$fetched_dump" ] || die "the dump did not come back: $fetched_dump"
bash "$REPO/scripts/db/restore.sh" "$fetched_dump" --database "$SCRATCH_DB" --create --yes | grep "^==> Restored"
src_m="$(sql "$DB_NAME" "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")"
dst_m="$(sql "$SCRATCH_DB" "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")"
[ "$src_m" = "$dst_m" ] || die "migration count differs: source $src_m, restored $dst_m"
printf '  %s applied migrations on both sides\n' "$dst_m"

elapsed=$(( $(date +%s) - started ))
printf '\nOFF-SITE DRILL PASSED: %s files shipped to %s encrypted, fetched on a clean workspace, %s sidecars verified, documents and database restored, %ss\n' \
  "$local_files" "$OFFSITE_REMOTE" "$n" "$elapsed"
