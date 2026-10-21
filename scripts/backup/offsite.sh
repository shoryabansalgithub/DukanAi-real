#!/usr/bin/env bash
# Off-site copies (roadmap 9.4): ships the backup directory (dumps and their
# sidecars, the binary-log archive, the documents archives, the status
# stamps) to object storage in another region or account, encrypted on the
# way with rclone's crypt backend, and brings it back for a restore on a
# clean machine. The key never leaves the secret store: it arrives as an
# environment variable and is obscured for rclone at run time.
#
#   scripts/backup/offsite.sh push [--full]    copy what is not yet confirmed off-site, verify it, prune by age
#   scripts/backup/offsite.sh check            verify every local file against the remote (cryptcheck)
#   scripts/backup/offsite.sh list             what the remote holds (decrypted names, sizes)
#   scripts/backup/offsite.sh fetch DIR [--only GLOB]
#                                              copy the remote (or the files matching GLOB) into DIR
#
# Environment:
#   OFFSITE_REMOTE          an rclone path on the target: "s3:bucket/dukaanai", "b2:bucket/path",
#                           "gcs:bucket/path", "r2:bucket/path", or "local:/mnt/offsite" for a drill;
#                           the backend's credentials are rclone environment variables, e.g.
#                           RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=AWS
#                           RCLONE_CONFIG_S3_ACCESS_KEY_ID=... RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=...
#                           RCLONE_CONFIG_S3_REGION=ap-south-1 (docs/BACKUP_RESTORE.md lists the providers)
#   OFFSITE_CRYPT_PASSWORD  the encryption key (32+ characters; losing it loses every off-site copy)
#   OFFSITE_CRYPT_SALT      optional second key (recommended; same rules)
#   OFFSITE_KEEP_DAYS       remote files older than this are deleted on push (default 30; 0 = keep all)
#   OFFSITE_HOURLY_KEEP_DAYS  the same for the hourly/ directory (db-ops backup-loop's hourly dumps),
#                           when shorter (default OFFSITE_KEEP_DAYS)
#   BACKUP_DIR              the local backup directory (default /var/backups/dukaanai)
#
# File names and contents are encrypted (crypt "standard" names); a listing of
# the bucket shows nothing readable. Records the success in BACKUP_STATUS_DIR.
#
# push is incremental: <BACKUP_DIR>/.offsite-confirmed lists every file (path,
# size, modification time) a push copied and cryptchecked, and the next push
# ships and checks only the files not on that list, so an hourly push does not
# re-read every archive. --full ignores the list (every file checked again);
# check always verifies the whole set. A local file older than its remote
# retention is neither shipped nor checked (the prune would delete it). The
# status stamps are copied on every push and never checked (every job
# rewrites them). A file deleted from the bucket behind the list's back is
# found by check and re-shipped by push --full. Two pushes at once are
# harmless: each lists only what it verified itself, so the worst a race
# costs is a file checked again by the next push.
set -euo pipefail
. "$(dirname "$0")/../db/lib.sh"

CMD="${1:-}"; shift || true
[ -n "$CMD" ] || { sed -n '2,42p' "$0"; exit 2; }
DEST=""; ONLY=""; FULL=0
case "$CMD" in
  fetch) DEST="${1:-}"; shift || true; [ -n "$DEST" ] || die "fetch needs a destination directory" ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --full) FULL=1; shift ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v rclone >/dev/null 2>&1 || die "rclone not found (apt-get install rclone, or https://rclone.org/install/)"
[ -n "${OFFSITE_REMOTE:-}" ] || die "OFFSITE_REMOTE is not set (e.g. s3:bucket/dukaanai, or local:/mnt/offsite for a drill)"
[ -n "${OFFSITE_CRYPT_PASSWORD:-}" ] || die "OFFSITE_CRYPT_PASSWORD is not set: the off-site copy is always encrypted"
[ "${#OFFSITE_CRYPT_PASSWORD}" -ge 32 ] || die "OFFSITE_CRYPT_PASSWORD must be at least 32 characters"
[ -z "${OFFSITE_CRYPT_SALT:-}" ] || [ "${#OFFSITE_CRYPT_SALT}" -ge 32 ] || die "OFFSITE_CRYPT_SALT must be at least 32 characters when set"
KEEP_DAYS="${OFFSITE_KEEP_DAYS:-30}"
case "$KEEP_DAYS" in *[!0-9]*|"") die "OFFSITE_KEEP_DAYS must be a whole number (got '$KEEP_DAYS')" ;; esac
HOURLY_KEEP_DAYS="${OFFSITE_HOURLY_KEEP_DAYS:-$KEEP_DAYS}"
case "$HOURLY_KEEP_DAYS" in *[!0-9]*|"") die "OFFSITE_HOURLY_KEEP_DAYS must be a whole number (got '$HOURLY_KEEP_DAYS')" ;; esac
SRC="${BACKUP_DIR:-/var/backups/dukaanai}"; SRC="${SRC%/}"
STATE="$SRC/.offsite-confirmed"

# The crypt remote "offsite" wraps OFFSITE_REMOTE; configured through the
# environment only, so no rclone.conf holds the key. "local" is defined here
# so that local:/dir works for a drill without any configuration.
export RCLONE_CONFIG_LOCAL_TYPE=local
export RCLONE_CONFIG_OFFSITE_TYPE=crypt
export RCLONE_CONFIG_OFFSITE_REMOTE="$OFFSITE_REMOTE"
export RCLONE_CONFIG_OFFSITE_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_OFFSITE_DIRECTORY_NAME_ENCRYPTION=true
# The keys go to `rclone obscure` on stdin ("-"), never as an argument: any
# user on the host can read a process's arguments (`ps`), audit P3.
RCLONE_CONFIG_OFFSITE_PASSWORD="$(printf '%s' "$OFFSITE_CRYPT_PASSWORD" | rclone obscure -)" || die "rclone obscure failed"; export RCLONE_CONFIG_OFFSITE_PASSWORD
if [ -n "${OFFSITE_CRYPT_SALT:-}" ]; then
  RCLONE_CONFIG_OFFSITE_PASSWORD2="$(printf '%s' "$OFFSITE_CRYPT_SALT" | rclone obscure -)" || die "rclone obscure failed"; export RCLONE_CONFIG_OFFSITE_PASSWORD2
fi
RC=(rclone --transfers 4 --checkers 8 --stats 0 --retries 3 --low-level-retries 10)

# Every local file a push ships, one "path<TAB>size<TAB>mtime" line each,
# sorted. In-flight and temporary files and dot directories (a local drill
# remote placed under the backup directory, for instance) never leave the
# host, nor does a file older than its remote retention.
shippable() {
  local now cutoff=0 hourly_cutoff=0
  now="$(date +%s)"
  [ "$KEEP_DAYS" -eq 0 ] || cutoff=$((now - KEEP_DAYS * 86400))
  [ "$HOURLY_KEEP_DAYS" -eq 0 ] || hourly_cutoff=$((now - HOURLY_KEEP_DAYS * 86400))
  ( cd "$SRC" && find . -type f ! -path '*/.*' -printf '%P\t%s\t%T@\n' ) \
    | awk -F '\t' -v c="$cutoff" -v h="$hourly_cutoff" '{ limit = ($1 ~ /^hourly\//) ? h : c; if ($3 >= limit) print }' \
    | LC_ALL=C sort
}

case "$CMD" in
  push)
    [ -d "$SRC" ] || die "backup directory not found: $SRC (BACKUP_DIR)"
    # One snapshot of what to ship (audit F11): the backup jobs keep writing
    # into SRC, and the copy and the check both work from this list.
    current="$(mktemp)"; confirmed="$(mktemp)"; pending="$(mktemp)"; copylist="$(mktemp)"
    trap 'rm -f "$current" "$confirmed" "$pending" "$copylist" "$STATE.tmp"' EXIT
    shippable > "$current"
    if [ "$FULL" = 0 ] && [ -f "$STATE" ]; then
      LC_ALL=C sort -u "$STATE" | LC_ALL=C comm -12 - "$current" > "$confirmed"
    fi
    LC_ALL=C comm -23 "$current" "$confirmed" | grep -v '^status/' > "$pending" || true
    { cut -f1 "$pending"; grep '^status/' "$current" | cut -f1 || true; } > "$copylist"
    total="$(grep -vc '^status/' "$current" || true)"; n="$(wc -l < "$pending" | tr -d ' ')"
    step "Off-site copy: $SRC -> $OFFSITE_REMOTE (encrypted): $n new of $total file(s)"
    if [ -s "$copylist" ]; then
      "${RC[@]}" copy "$SRC" offsite: --files-from-raw "$copylist" || die "rclone copy failed: nothing new is confirmed off-site"
    fi
    if [ "$n" -gt 0 ]; then
      step "Verifying the $n new file(s) against their encrypted copies (rclone cryptcheck)"
      cut -f1 "$pending" > "$copylist"
      "${RC[@]}" cryptcheck "$SRC" offsite: --one-way --files-from-raw "$copylist" || die "the off-site copy does not match the local files"
    fi
    LC_ALL=C sort -u "$confirmed" "$pending" > "$STATE.tmp"
    mv -f "$STATE.tmp" "$STATE"
    if [ "$KEEP_DAYS" -gt 0 ]; then
      step "Pruning off-site files older than $KEEP_DAYS days"
      "${RC[@]}" delete offsite: --min-age "${KEEP_DAYS}d" || die "pruning failed"
    fi
    if [ -d "$SRC/hourly" ] && [ "$HOURLY_KEEP_DAYS" -gt 0 ] && { [ "$KEEP_DAYS" -eq 0 ] || [ "$HOURLY_KEEP_DAYS" -lt "$KEEP_DAYS" ]; }; then
      step "Pruning off-site hourly dumps older than $HOURLY_KEEP_DAYS days"
      "${RC[@]}" delete offsite:hourly --min-age "${HOURLY_KEEP_DAYS}d" || die "pruning the hourly dumps failed"
    fi
    "${RC[@]}" rmdirs offsite: --leave-root >/dev/null 2>&1 || true
    summary="$(rclone size offsite: 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')"
    record_success offsite "$OFFSITE_REMOTE $summary"
    step "Off-site copy complete: $n shipped and verified, $((total - n)) already confirmed; $OFFSITE_REMOTE holds $summary"
    ;;
  check)
    [ -d "$SRC" ] || die "backup directory not found: $SRC (BACKUP_DIR)"
    list="$(mktemp)"
    trap 'rm -f "$list"' EXIT
    shippable | grep -v '^status/' | cut -f1 > "$list" || true
    step "Verifying all $(wc -l < "$list" | tr -d ' ') file(s) of $SRC against $OFFSITE_REMOTE (rclone cryptcheck)"
    "${RC[@]}" cryptcheck "$SRC" offsite: --one-way --files-from-raw "$list" || die "the off-site copy does not match the local files"
    step "Every local file has an identical encrypted copy off-site"
    ;;
  list)
    rclone lsl offsite:
    ;;
  fetch)
    mkdir -p "$DEST" || die "cannot create $DEST"
    step "Fetching ${ONLY:-everything} from $OFFSITE_REMOTE into $DEST (decrypted)"
    if [ -n "$ONLY" ]; then
      "${RC[@]}" copy offsite: "$DEST" --include "$ONLY" || die "rclone copy failed"
    else
      "${RC[@]}" copy offsite: "$DEST" || die "rclone copy failed"
    fi
    n="$(find "$DEST" -type f | wc -l | tr -d ' ')"
    step "Fetched $n file(s) into $DEST; verify the .sha256 sidecars before restoring (sha256sum -c)"
    ;;
  *) die "unknown command: $CMD (push [--full] | check | list | fetch DIR)" ;;
esac
