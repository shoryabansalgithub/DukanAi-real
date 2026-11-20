#!/usr/bin/env bash
# Self-test of the incremental off-site push (scripts/backup/offsite.sh)
# against a local rclone remote: no database, no cloud account; needs rclone
# and GNU find / touch.
#
#   bash scripts/backup/offsite.test.sh
#
# A first push ships and checks every file; a second ships and checks none;
# a new dump ships alone; a pushed file that later rots in the bucket is not
# re-read by the incremental push, but check and push --full find it, and
# push --full re-ships it once the bad object is gone; status stamps are
# copied and never checked; hourly dumps leave the bucket after
# OFFSITE_HOURLY_KEEP_DAYS while nightly files stay; the list never leaves
# the host and the bucket holds no readable name; what fetch brings back is
# byte for byte the local file. Exit 0 when every check passes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v rclone >/dev/null 2>&1 || { echo "rclone not found" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export BACKUP_DIR="$WORK/backups" BACKUP_STATUS_DIR="$WORK/backups/status"
export OFFSITE_REMOTE="local:$WORK/bucket"
export OFFSITE_CRYPT_PASSWORD=offsite-test-password-of-at-least-32-characters
export OFFSITE_KEEP_DAYS=30
unset OFFSITE_HOURLY_KEEP_DAYS OFFSITE_CRYPT_SALT
mkdir -p "$BACKUP_DIR/documents" "$BACKUP_DIR/hourly" "$BACKUP_STATUS_DIR"
file() { mkdir -p "$(dirname "$BACKUP_DIR/$1")"; head -c "$2" /dev/urandom > "$BACKUP_DIR/$1"; }

failures=0
check() {
  if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: got [%s], want [%s]\n' "$1" "$2" "$3"; failures=$((failures + 1)); fi
}
offsite() { bash "$HERE/offsite.sh" "$@" 2>&1; }
# "<new> of <total>" from a push's first line.
pushed() { sed -n 's/^==> Off-site copy: .*(encrypted): \([0-9]* new of [0-9]*\) file(s)$/\1/p' <<<"$1"; }
outcome() { if "$@" >/dev/null 2>&1; then echo passed; else echo failed; fi; }
bucket_objects() { find "$WORK/bucket" -type f | wc -l | tr -d ' '; }

file dukaanai-20261016T000000Z.sql.gz 2000
( cd "$BACKUP_DIR" && sha256sum dukaanai-20261016T000000Z.sql.gz > dukaanai-20261016T000000Z.sql.gz.sha256 )
file documents/documents-20261016T000000Z.tar.gz 3000
file hourly/dukaanai-20261016T010000Z.sql.gz 1500
printf '2026-10-16T00:00:00Z\n/backups/x\n' > "$BACKUP_STATUS_DIR/dump.last-success"

out="$(offsite push)"
check "first push ships every file" "$(pushed "$out")" "4 new of 4"
check "first push checks the new files" "$(grep -c '^==> Verifying the 4 new file(s)' <<<"$out")" 1
check "the bucket holds the files and the status stamp" "$(bucket_objects)" 5
check "the list names the four checked files" "$(cut -f1 "$BACKUP_DIR/.offsite-confirmed" | tr '\n' ' ')" \
  "documents/documents-20261016T000000Z.tar.gz dukaanai-20261016T000000Z.sql.gz dukaanai-20261016T000000Z.sql.gz.sha256 hourly/dukaanai-20261016T010000Z.sql.gz "

out="$(offsite push)"
check "a push with nothing new ships nothing" "$(pushed "$out")" "0 new of 4"
check "a push with nothing new checks nothing" "$(grep -c '^==> Verifying' <<<"$out" || true)" 0

file hourly/dukaanai-20261016T020000Z.sql.gz 1600
out="$(offsite push)"
check "a new hourly dump ships alone" "$(pushed "$out")" "1 new of 5"

# Bit rot in the bucket (size and modification time unchanged, as on object
# storage): the largest object is the documents archive.
rotten="$(find "$WORK/bucket" -type f -printf '%s %p\n' | sort -n | tail -n 1 | cut -d' ' -f2)"
touch -r "$rotten" "$WORK/mtime"
printf 'x' | dd of="$rotten" bs=1 seek=100 conv=notrunc status=none
touch -r "$WORK/mtime" "$rotten"
check "the incremental push does not re-read a confirmed file" "$(outcome offsite push)" passed
check "check verifies the whole set and finds the rotten copy" "$(outcome offsite check)" failed
check "push --full re-checks everything and finds it too" "$(outcome offsite push --full)" failed
rm -f "$rotten"
out="$(offsite push --full)"
check "push --full re-ships what the bucket lost" "$(pushed "$out")" "5 new of 5"
check "check passes again" "$(outcome offsite check)" passed

printf '2026-10-16T09:00:00Z\n/backups/y\n' > "$BACKUP_STATUS_DIR/dump.last-success"
check "a rewritten status stamp does not fail check" "$(outcome offsite check)" passed

rm -f "$BACKUP_DIR/hourly/dukaanai-20261016T010000Z.sql.gz"
offsite push >/dev/null
check "a pruned local dump leaves the list" "$(grep -c 'T010000Z' "$BACKUP_DIR/.offsite-confirmed" || true)" 0

file hourly/dukaanai-20261013T020000Z.sql.gz 1700
file dukaanai-20261013T000000Z.sql.gz 1800
touch -d '3 days ago' "$BACKUP_DIR/hourly/dukaanai-20261013T020000Z.sql.gz" "$BACKUP_DIR/dukaanai-20261013T000000Z.sql.gz"
out="$(offsite push)"
check "files inside the retention ship whatever their age" "$(pushed "$out")" "2 new of 6"
out="$(OFFSITE_HOURLY_KEEP_DAYS=2 offsite push)"
check "an hourly dump past OFFSITE_HOURLY_KEEP_DAYS is no longer shipped" "$(pushed "$out")" "0 new of 5"
listing="$(offsite list)"
check "it leaves the bucket" "$(grep -c '20261013T020000Z' <<<"$listing" || true)" 0
check "a nightly dump of the same age stays" "$(grep -c 'dukaanai-20261013T000000Z.sql.gz$' <<<"$listing" || true)" 1
check "check with the shorter hourly retention passes" "$(OFFSITE_HOURLY_KEEP_DAYS=2 bash "$HERE/offsite.sh" check >/dev/null 2>&1 && echo passed || echo failed)" passed

check "the list never leaves the host" "$(grep -c 'offsite-confirmed' <<<"$listing" || true)" 0
check "no readable name in the bucket" "$(find "$WORK/bucket" | grep -Ec 'sql|tar|sha256|hourly|documents|status' || true)" 0

offsite fetch "$WORK/back" --only 'hourly/**' >/dev/null
check "fetched bytes equal the local dump" "$(sha256sum < "$WORK/back/hourly/dukaanai-20261016T020000Z.sql.gz")" "$(sha256sum < "$BACKUP_DIR/hourly/dukaanai-20261016T020000Z.sql.gz")"
check "every push stamped offsite" "$(sed -n 2p "$BACKUP_STATUS_DIR/offsite.last-success" | cut -d' ' -f1)" "$OFFSITE_REMOTE"

[ "$failures" -eq 0 ] || { printf '%s check(s) failed\n' "$failures"; exit 1; }
printf 'offsite.sh: every check passed\n'
