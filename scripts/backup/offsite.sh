#!/usr/bin/env bash
# Off-site copies (roadmap 9.4): ships the backup directory (dumps and their
# sidecars, the binary-log archive, the documents archives, the status
# stamps) to object storage in another region or account, encrypted on the
# way with rclone's crypt backend, and brings it back for a restore on a
# clean machine. The key never leaves the secret store: it arrives as an
# environment variable and is obscured for rclone at run time.
#
#   scripts/backup/offsite.sh push             copy everything new to the remote, verify, prune by age
#   scripts/backup/offsite.sh check            verify the remote against the local directory (cryptcheck)
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
#   BACKUP_DIR              the local backup directory (default /var/backups/dukaanai)
#
# File names and contents are encrypted (crypt "standard" names); a listing of
# the bucket shows nothing readable. Records the success in BACKUP_STATUS_DIR.
set -euo pipefail
. "$(dirname "$0")/../db/lib.sh"

CMD="${1:-}"; shift || true
[ -n "$CMD" ] || { sed -n '2,30p' "$0"; exit 2; }
DEST=""; ONLY=""
case "$CMD" in
  fetch) DEST="${1:-}"; shift || true; [ -n "$DEST" ] || die "fetch needs a destination directory" ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
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
SRC="${BACKUP_DIR:-/var/backups/dukaanai}"

# The crypt remote "offsite" wraps OFFSITE_REMOTE; configured through the
# environment only, so no rclone.conf holds the key. "local" is defined here
# so that local:/dir works for a drill without any configuration.
export RCLONE_CONFIG_LOCAL_TYPE=local
export RCLONE_CONFIG_OFFSITE_TYPE=crypt
export RCLONE_CONFIG_OFFSITE_REMOTE="$OFFSITE_REMOTE"
export RCLONE_CONFIG_OFFSITE_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_OFFSITE_DIRECTORY_NAME_ENCRYPTION=true
RCLONE_CONFIG_OFFSITE_PASSWORD="$(rclone obscure "$OFFSITE_CRYPT_PASSWORD")"; export RCLONE_CONFIG_OFFSITE_PASSWORD
if [ -n "${OFFSITE_CRYPT_SALT:-}" ]; then
  RCLONE_CONFIG_OFFSITE_PASSWORD2="$(rclone obscure "$OFFSITE_CRYPT_SALT")"; export RCLONE_CONFIG_OFFSITE_PASSWORD2
fi
# In-flight and temporary files, and dot directories (a local drill remote
# placed under the backup directory, for instance), never leave the host.
FILTERS=(--exclude '.*' --exclude '**/.*' --exclude '.*/**' --exclude '**/.*/**')
RC=(rclone --transfers 4 --checkers 8 --stats 0 --retries 3 --low-level-retries 10)

case "$CMD" in
  push)
    [ -d "$SRC" ] || die "backup directory not found: $SRC (BACKUP_DIR)"
    step "Off-site copy: $SRC -> $OFFSITE_REMOTE (encrypted)"
    "${RC[@]}" copy "$SRC" offsite: "${FILTERS[@]}" || die "rclone copy failed: nothing is confirmed off-site"
    step "Verifying every local file against its encrypted copy (rclone cryptcheck)"
    "${RC[@]}" cryptcheck "$SRC" offsite: --one-way "${FILTERS[@]}" || die "the off-site copy does not match the local files"
    if [ "$KEEP_DAYS" -gt 0 ]; then
      step "Pruning off-site files older than $KEEP_DAYS days"
      "${RC[@]}" delete offsite: --min-age "${KEEP_DAYS}d" || die "pruning failed"
      "${RC[@]}" rmdirs offsite: --leave-root >/dev/null 2>&1 || true
    fi
    summary="$(rclone size offsite: 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')"
    record_success offsite "$OFFSITE_REMOTE $summary"
    step "Off-site copy complete: $OFFSITE_REMOTE holds $summary"
    ;;
  check)
    step "Verifying $SRC against $OFFSITE_REMOTE (rclone cryptcheck)"
    "${RC[@]}" cryptcheck "$SRC" offsite: --one-way "${FILTERS[@]}" || die "the off-site copy does not match the local files"
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
  *) die "unknown command: $CMD (push | check | list | fetch DIR)" ;;
esac
