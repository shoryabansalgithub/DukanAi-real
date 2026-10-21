#!/usr/bin/env bash
# Turns a fresh Azure VM running Ubuntu 24.04 (Standard_B2pts_v2, arm64; amd64
# works too) into a DukaanAI host, and converges it again on every later run.
# deploy/azure/main.bicep creates the VM and the managed MySQL server, and
# deploy/azure/cloud-init.yaml runs this script once on first boot.
#
#   sudo deploy/azure/bootstrap.sh [--ref vX.Y.Z] [--no-start]
#   sudo deploy/azure/bootstrap.sh --env-only [--env-file PATH]
#
# Each run installs or confirms: Docker CE and the compose plugin (Docker's
# apt repository, key fingerprint checked; compose 2.24.4 or newer), time
# sync, Docker log rotation, security updates with a reboot window outside
# shop hours, a swap file and the memory settings a 1 GiB host needs, the
# data directories under /srv/dukaanai, the checkout at /opt/dukaanai, the
# Azure MySQL CA at /etc/dukaanai/db-ca.pem, and the settings file
# /etc/dukaanai/dukaanai.env (created once with every secret a machine can
# generate, never overwritten). The firewall is the Azure network security
# group: this script only reports a host firewall it finds, it never adds
# one. When the owner's values are still blank it stops and lists them
# (exit 3); once they are filled it runs `deploy/azure/stack.sh up`.
#
# Options:
#   --ref REF          the git ref to check out (default: see resolve_ref)
#   --repo URL         the repository (default: the project's GitHub URL)
#   --env-file PATH    the settings file (default /etc/dukaanai/dukaanai.env)
#   --reboot-time HH:MM  when an update may reboot, in --reboot-tz (03:30)
#   --reboot-tz ZONE   the zone of --reboot-time (Asia/Kolkata)
#   --no-start         converge the host, never run stack.sh
#   --env-only         only the OS check, the settings file and the list of
#                      missing values: nothing is installed or changed on the
#                      host (works in a plain container)
#
# Exit codes: 0 done, 1 refused or failed, 2 usage, 3 the host is ready and
# waits for the owner's values in the settings file.
set -Eeuo pipefail

REPO_URL="https://github.com/shoryabansalgithub/DukanAi-real.git"
CHECKOUT=/opt/dukaanai
ENV_FILE=/etc/dukaanai/dukaanai.env
CA_FILE=/etc/dukaanai/db-ca.pem
DATA_ROOT=/srv/dukaanai
TARGET=deploy/azure
REF=""
REBOOT_TIME="03:30"
REBOOT_TZ="Asia/Kolkata"
NO_START=0
ENV_ONLY=0
COMPOSE_FILES="docker-compose.prod.yml:$TARGET/compose.yml"
MIN_COMPOSE="2.24.4"
DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
SWAP_SIZE_MB=2048
SYSCTL_FILE=/etc/sysctl.d/60-dukaanai.conf

CHANGED=()
ALREADY=()
NOTES=()
ENV_CREATED=0
MISSING=()

changed() { CHANGED+=("$*"); log "changed: $*"; }
already() { ALREADY+=("$*"); log "ok: $*"; }
note() { NOTES+=("$*"); log "note: $*"; }
log() { printf 'bootstrap: %s\n' "$*" >&2; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -E/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
      --repo) REPO_URL="${2:?--repo needs a value}"; shift 2 ;;
      --env-file) ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
      --reboot-time) REBOOT_TIME="${2:?--reboot-time needs a value}"; shift 2 ;;
      --reboot-tz) REBOOT_TZ="${2:?--reboot-tz needs a value}"; shift 2 ;;
      --no-start) NO_START=1; shift ;;
      --env-only) ENV_ONLY=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac
  done
  [[ "$REBOOT_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "--reboot-time must be HH:MM (got $REBOOT_TIME)"
}

# ---------------------------------------------------------------- preflight

preflight() {
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)"
  local id="" version="" arch
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && echo "${ID:-}")"
    # shellcheck disable=SC1091
    version="$(. /etc/os-release && echo "${VERSION_ID:-}")"
  fi
  arch="$(uname -m)"
  [ "$id" = ubuntu ] && [ "$version" = "24.04" ] \
    || die "this host is ${id:-unknown} ${version:-unknown}; bootstrap.sh supports Ubuntu 24.04 only (Canonical's ubuntu-24_04-lts image)"
  case "$arch" in
    aarch64|x86_64) ;;
    *) die "this host is $arch; bootstrap.sh supports aarch64 (Standard_B2pts_v2) and x86_64 only" ;;
  esac
  already "Ubuntu 24.04 on $arch"
}

take_lock() {
  # A re-executed newer copy inherits the lock on fd 9.
  [ "${DUKAANAI_BOOTSTRAP_LOCKED:-}" = 1 ] && return
  mkdir -p /run/lock
  exec 9>/run/lock/dukaanai-bootstrap.lock
  flock -n 9 || die "another bootstrap.sh is running (cloud-init or a second shell); wait for it"
  export DUKAANAI_BOOTSTRAP_LOCKED=1
}

# ---------------------------------------------------------------- helpers

# Writes CONTENT (stdin) to PATH with MODE when it differs; prints "changed"
# or "same".
converge_file() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    chmod "$mode" "$path"
    echo same
  else
    install -D -m "$mode" -o root -g root "$tmp" "$path"
    rm -f "$tmp"
    echo changed
  fi
}

apt_install() {
  local missing=() pkg
  for pkg in "$@"; do
    [ "$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null || true)" = "install ok installed" ] || missing+=("$pkg")
  done
  [ "${#missing[@]}" -eq 0 ] && return 1
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends "${missing[@]}" >/dev/null
  printf '%s ' "${missing[@]}"
}

apt_update() {
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null
}

# ---------------------------------------------------------------- host steps

step_base_packages() {
  local got
  apt_update
  if got="$(apt_install ca-certificates curl git gnupg openssl)"; then
    changed "installed $got"
  else
    already "base packages (curl, git, gnupg, openssl)"
  fi
}

step_docker() {
  local codename arch key_tmp fpr sources got version
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  arch="$(dpkg --print-architecture)"
  key_tmp="$(mktemp)"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key_tmp"
  fpr="$(gpg --show-keys --with-colons "$key_tmp" 2>/dev/null | awk -F: '/^fpr:/ { print $10; exit }')"
  if [ "$fpr" != "$DOCKER_KEY_FINGERPRINT" ]; then
    rm -f "$key_tmp"
    die "Docker's apt key has fingerprint '${fpr:-none}', expected $DOCKER_KEY_FINGERPRINT: refusing to trust it"
  fi
  if [ "$(converge_file /etc/apt/keyrings/docker.asc 0644 <"$key_tmp")" = changed ]; then
    changed "Docker apt key (fingerprint $DOCKER_KEY_FINGERPRINT)"
  else
    already "Docker apt key"
  fi
  rm -f "$key_tmp"
  sources="$(converge_file /etc/apt/sources.list.d/docker.sources 0644 <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
)"
  if [ "$sources" = changed ]; then
    changed "Docker apt repository ($codename stable, $arch)"
    apt_update
  else
    already "Docker apt repository"
  fi
  if got="$(apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)"; then
    changed "installed $got"
  else
    already "Docker CE and the compose plugin"
  fi
  if ! systemctl is-enabled --quiet docker || ! systemctl is-active --quiet docker; then
    systemctl enable --now docker >/dev/null 2>&1
    changed "docker service enabled and started"
  fi
  version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  [ -n "$version" ] || die "docker compose is not available after the install"
  [ "$(printf '%s\n%s\n' "$MIN_COMPOSE" "$version" | sort -V | head -n 1)" = "$MIN_COMPOSE" ] \
    || die "docker compose $version is older than $MIN_COMPOSE (the compose files need include lists and !reset)"
  already "docker compose $version (>= $MIN_COMPOSE)"
}

step_docker_logs() {
  local file=/etc/docker/daemon.json
  local want='{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}'
  if [ ! -s "$file" ]; then
    install -d -m 0755 /etc/docker
    printf '%s\n' "$want" >"$file.tmp"
    chmod 0644 "$file.tmp"
    mv "$file.tmp" "$file"
    systemctl restart docker
    changed "Docker log rotation (json-file, 5 x 10 MB) in $file"
  elif [ "$(tr -d ' \t\r\n' <"$file")" = "$want" ]; then
    already "Docker log rotation"
  else
    note "$file has other settings: left alone (want $want; every compose service rotates its own logs anyway)"
  fi
}

step_time_sync() {
  local got
  if systemctl is-active --quiet chrony; then
    already "time sync (chrony)"
  elif systemctl is-active --quiet systemd-timesyncd; then
    already "time sync (systemd-timesyncd)"
  else
    got="$(apt_install chrony || true)"
    systemctl enable --now chrony >/dev/null 2>&1
    changed "time sync on (chrony${got:+, installed})"
  fi
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] \
    || note "the clock is not synchronised yet (timedatectl): invoice numbers and the business day come from it; check again in a minute"
}

# The network security group in main.bicep is the firewall. Canonical's
# Azure images ship ufw inactive and an empty INPUT chain; anything else was
# added by hand and would silently drop 80/443, so it is reported, never
# changed (enabling or editing a host firewall over SSH can lock the owner
# out, and Docker's published ports bypass ufw anyway).
step_firewall_check() {
  local input=""
  if command -v ufw >/dev/null 2>&1 && grep -q '^Status: active' <<<"$(ufw status 2>/dev/null || true)"; then
    note "ufw is active: the NSG is this host's firewall, and ufw may block 80/443 for the edge (ufw disable from the serial console if HTTPS does not answer)"
  fi
  if command -v iptables >/dev/null 2>&1; then
    input="$(iptables -S INPUT 2>/dev/null || true)"
  fi
  if grep -qE '^-A INPUT .*-j (REJECT|DROP)' <<<"$input" || grep -qE '^-P INPUT (DROP|REJECT)' <<<"$input"; then
    note "the host's iptables INPUT chain rejects traffic: the NSG already filters, make sure tcp 80, tcp 443 and udp 443 are accepted here too"
  else
    already "no host firewall in the way (the Azure NSG filters inbound traffic)"
  fi
}

step_updates() {
  local got host_time result
  if got="$(apt_install unattended-upgrades)"; then changed "installed $got"; fi
  # apt reboots at the host's local time; the window is given in shop time.
  host_time="$(date -d "TZ=\"$REBOOT_TZ\" $REBOOT_TIME" +%H:%M)" \
    || die "cannot convert $REBOOT_TIME $REBOOT_TZ to the host's time zone"
  result="$(converge_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
)"
  result+=" $(converge_file /etc/apt/apt.conf.d/52dukaanai-unattended-upgrades 0644 <<EOF
// Written by deploy/azure/bootstrap.sh. Security updates install daily
// (the Allowed-Origins of 50unattended-upgrades); a reboot they need waits
// for $REBOOT_TIME $REBOOT_TZ, outside shop hours. Docker's own repository is
// not an allowed origin, so the engine never restarts under the shops.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "$host_time";
EOF
)"
  case "$result" in
    *changed*) changed "security updates daily, reboot when needed at $REBOOT_TIME $REBOOT_TZ ($host_time host time)" ;;
    *) already "security updates daily, reboot window $REBOOT_TIME $REBOOT_TZ ($host_time host time)" ;;
  esac
}

# The B2pts_v2 has 1 GiB of memory and no temporary disk, so the swap file
# lives on the OS disk.
step_swap() {
  if [ -n "$(swapon --noheadings --show=NAME)" ]; then
    already "swap ($(swapon --noheadings --show=NAME,SIZE | tr -s ' ' | paste -sd, -))"
    return
  fi
  if [ ! -f /swapfile ]; then
    fallocate -l "${SWAP_SIZE_MB}M" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  changed "swap file /swapfile ($(swapon --noheadings --show=SIZE /swapfile | tr -d ' '))"
}

# vm.swappiness 10: swap is the safety net that keeps a 1 GiB host out of the
# OOM killer, not working memory; the disk under it is a managed disk with a
# small IOPS budget, so the kernel drops page cache before it swaps the
# API's heap. vm.overcommit_memory 1: Redis forks for its background save,
# and under the default heuristic that fork fails on a host this small
# (Redis's own startup warning asks for it).
SYSCTLS=(
  "vm.swappiness 10"
  "vm.overcommit_memory 1"
)

step_sysctl() {
  local entry key value content="" result live_ok=1
  for entry in "${SYSCTLS[@]}"; do
    read -r key value <<<"$entry"
    content+="$key = $value"$'\n'
    [ "$(sysctl -n "$key" 2>/dev/null)" = "$value" ] || live_ok=0
  done
  result="$(printf '# Written by deploy/azure/bootstrap.sh (see step_sysctl there).\n%s' "$content" | converge_file "$SYSCTL_FILE" 0644)"
  if [ "$result" = changed ] || [ "$live_ok" = 0 ]; then
    sysctl -q -p "$SYSCTL_FILE" >/dev/null
    changed "memory settings in $SYSCTL_FILE: vm.swappiness=10, vm.overcommit_memory=1"
  else
    already "memory settings (vm.swappiness=10, vm.overcommit_memory=1)"
  fi
}

# The API image's `node` user and the backup jobs (compose `user: 1000:1000`)
# are uid 1000. The database is the managed server: no MySQL directory here.
DATA_DIRS=(
  "storage 1000:1000 0750"
  "uploads 1000:1000 0750"
  "backups 1000:1000 0700"
)

step_data_dirs() {
  local entry name owner mode path did=()
  install -d -m 0755 -o root -g root "$DATA_ROOT"
  for entry in "${DATA_DIRS[@]}"; do
    read -r name owner mode <<<"$entry"
    path="$DATA_ROOT/$name"
    if [ -d "$path" ] && [ "$(stat -c '%u:%g %a' "$path")" = "$owner ${mode#0}" ]; then continue; fi
    install -d -m "$mode" "$path"
    chown "$owner" "$path"
    chmod "$mode" "$path"
    did+=("$name")
  done
  if [ "${#did[@]}" -gt 0 ]; then
    changed "data directories under $DATA_ROOT: ${did[*]}"
  else
    already "data directories under $DATA_ROOT (storage, uploads, backups; uid 1000)"
  fi
}

# The CA bundle that signs Azure Database for MySQL's server certificate,
# from the checkout (so a CA change ships as a commit). DATABASE_URL names it
# with sslcert=, and compose mounts it into every container that connects.
# It is public: mode 0644 so the containers' uid 1000 can read the mount.
step_db_ca() {
  local src="$CHECKOUT/$TARGET/azure-mysql-ca.pem"
  [ -s "$src" ] || die "$src is missing at this ref: the Azure MySQL CA comes from the repository"
  grep -q 'BEGIN CERTIFICATE' "$src" || die "$src holds no PEM certificate"
  install -d -m 0700 -o root -g root "$(dirname "$CA_FILE")"
  if [ "$(converge_file "$CA_FILE" 0644 <"$src")" = changed ]; then
    changed "Azure MySQL CA installed at $CA_FILE"
  else
    already "Azure MySQL CA at $CA_FILE"
  fi
}

# ---------------------------------------------------------------- checkout

# The default ref keeps the checkout on the commit the images were built
# from, because the compose files, stack.sh and the migrations the release
# step checks come from the checkout while the code comes from IMAGE_TAG:
#   1. --ref when given;
#   2. else IMAGE_TAG from the settings file (v1.2.3 is that tag, sha-<7> that
#      commit of main);
#   3. else (first boot, IMAGE_TAG still blank) the newest release tag that
#      carries this target, and main when no release does yet.
resolve_ref() {
  local tag
  if [ -n "$REF" ]; then echo "$REF"; return; fi
  tag="$(env_value IMAGE_TAG)"
  case "$tag" in
    v*) echo "$tag"; return ;;
    sha-*) echo "${tag#sha-}"; return ;;
    "") ;;
    *) die "IMAGE_TAG=$tag is neither a release tag (v1.2.3) nor a main build (sha-<7 hex>); pass --ref" ;;
  esac
  while read -r tag; do
    if git -C "$CHECKOUT" cat-file -e "$tag:$TARGET/stack.sh" 2>/dev/null; then echo "$tag"; return; fi
  done < <(git -C "$CHECKOUT" tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -rV)
  echo main
}

step_checkout() {
  local ref target head
  if [ ! -d "$CHECKOUT/.git" ]; then
    [ ! -e "$CHECKOUT" ] || [ -z "$(ls -A "$CHECKOUT")" ] || die "$CHECKOUT exists and is not a git checkout"
    git clone --quiet "$REPO_URL" "$CHECKOUT"
    changed "cloned $REPO_URL to $CHECKOUT"
  fi
  git -C "$CHECKOUT" fetch --quiet --tags --force --prune origin
  [ -z "$(git -C "$CHECKOUT" status --porcelain --untracked-files=no)" ] \
    || die "$CHECKOUT has local changes: commit them elsewhere or discard them (git -C $CHECKOUT diff), then run again"
  ref="$(resolve_ref)"
  # A branch name means the fetched branch, never a stale local one.
  target="$(git -C "$CHECKOUT" rev-parse --verify -q "origin/$ref^{commit}" || git -C "$CHECKOUT" rev-parse --verify -q "$ref^{commit}")" \
    || die "the ref '$ref' does not exist in $REPO_URL"
  git -C "$CHECKOUT" cat-file -e "$target:$TARGET/stack.sh" 2>/dev/null \
    || die "the ref '$ref' predates the Azure target (no $TARGET/stack.sh)"
  head="$(git -C "$CHECKOUT" rev-parse -q --verify HEAD || true)"
  if [ "$head" = "$target" ]; then
    already "checkout $CHECKOUT at $ref (${target:0:7})"
  else
    git -C "$CHECKOUT" -c advice.detachedHead=false checkout --quiet --detach "$target"
    changed "checkout $CHECKOUT moved to $ref (${target:0:7})"
  fi
}

# The ref's own bootstrap.sh decides the rest of the run.
reexec_if_newer() {
  local mine="$CHECKOUT/$TARGET/bootstrap.sh"
  [ -f "$mine" ] || return 0
  [ "${DUKAANAI_BOOTSTRAP_REEXEC:-}" = 1 ] && return 0
  [ "$(sha256sum <"$mine")" = "$SELF_SUM" ] && return 0
  log "the checkout's bootstrap.sh differs from this one: running it"
  export DUKAANAI_BOOTSTRAP_REEXEC=1
  exec bash "$mine" "${ORIGINAL_ARGS[@]}"
}

# ---------------------------------------------------------------- settings file

# What each variable of the settings file is:
#   generated  a secret `openssl rand -hex` makes (hex is safe in URLs and SQL)
#   derived    assembled from other values (derived_value); written once the
#              values it needs are there, checked against them on every run
#   owner      only the owner has it; the stack does not start while blank
#   optional   the owner's, blank switches the feature off
GENERATED=(JWT_SECRET NEXTAUTH_SECRET METRICS_TOKEN GRAFANA_ADMIN_PASSWORD
  MYSQL_PASSWORD MYSQL_BACKUP_PASSWORD REDIS_PASSWORD
  OFFSITE_CRYPT_PASSWORD OFFSITE_CRYPT_SALT)
DERIVED=(DATABASE_URL DB_OPS_DATABASE_URL REDIS_URL)
OWNER=(IMAGE_TAG WEB_HOST API_HOST WEB_ORIGIN API_PUBLIC_URL
  AZURE_MYSQL_HOST AZURE_MYSQL_ADMIN_USER AZURE_MYSQL_ADMIN_PASSWORD
  OFFSITE_REMOTE RCLONE_CONFIG_B2_ENDPOINT RCLONE_CONFIG_B2_REGION
  RCLONE_CONFIG_B2_ACCESS_KEY_ID RCLONE_CONFIG_B2_SECRET_ACCESS_KEY
  SMTP_URL EMAIL_FROM)
OPTIONAL=(GEMINI_API_KEY ALERT_EMAIL_TO SENTRY_DSN)

# The value KEY has in the settings file (last assignment wins, as in
# compose), quotes removed; empty when absent. The file is parsed, never
# sourced.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  awk -v key="$1" -v q="'" '
    /^[[:space:]]*#/ { next }
    index($0, key "=") == 1 { v = substr($0, length(key) + 2); found = 1 }
    END {
      if (!found) exit
      first = substr(v, 1, 1); last = substr(v, length(v), 1)
      if (length(v) >= 2 && first == last && (first == "\"" || first == q)) v = substr(v, 2, length(v) - 2)
      print v
    }' "$ENV_FILE"
}

env_has() { [ -f "$ENV_FILE" ] && grep -qE "^$1=" "$ENV_FILE"; }

# What a derived KEY must be, from the file's current values (VALUES, an
# associative array name, overrides them while the file is being rendered);
# empty while an input is still blank. The one place each URL is spelled.
derived_value() {
  local key="$1" host pw bpw rpw db user
  local -n over="${2:-_NO_OVERRIDES}"
  pick() { if [ -n "${over[$1]:-}" ]; then echo "${over[$1]}"; else env_value "$1"; fi; }
  host="$(pick AZURE_MYSQL_HOST)"; db="$(pick MYSQL_DATABASE)"; user="$(pick MYSQL_USER)"
  db="${db:-dukaanai}"; user="${user:-dukaanai}"
  case "$key" in
    DATABASE_URL)
      pw="$(pick MYSQL_PASSWORD)"
      [ -n "$host" ] && [ -n "$pw" ] || return 0
      echo "mysql://$user:$pw@$host:3306/$db?connection_limit=20&sslaccept=strict&sslcert=$CA_FILE" ;;
    DB_OPS_DATABASE_URL)
      bpw="$(pick MYSQL_BACKUP_PASSWORD)"
      [ -n "$host" ] && [ -n "$bpw" ] || return 0
      echo "mysql://dukaanai_backup:$bpw@$host:3306/$db?sslaccept=strict&sslcert=$CA_FILE" ;;
    REDIS_URL)
      rpw="$(pick REDIS_PASSWORD)"
      [ -n "$rpw" ] || return 0
      echo "redis://:$rpw@redis:6379/0" ;;
  esac
}
declare -A _NO_OVERRIDES=()

# KEY=VALUE for each derived KEY that has a value yet (VALUES as in
# derived_value); nothing for the others, so a blank one is never written.
derived_lines() {
  local values="$1" key value
  shift
  for key in "$@"; do
    value="$(derived_value "$key" "$values")"
    [ -z "$value" ] || printf '%s=%s\n' "$key" "$value"
  done
}

render_settings() {
  local -A v=()
  local key
  for key in "${GENERATED[@]}"; do
    v[$key]="$(env_value "$key")"
    [ -n "${v[$key]}" ] && continue
    if [ "$key" = GRAFANA_ADMIN_PASSWORD ]; then v[$key]="$(openssl rand -hex 24)"; else v[$key]="$(openssl rand -hex 32)"; fi
  done
  cat <<EOF
# DukaanAI on one Azure VM with Azure Database for MySQL (deploy/azure).
# Written once by deploy/azure/bootstrap.sh; it never overwrites this file (a
# key a newer bootstrap.sh knows and this file lacks is appended).
# Mode 600, root only. Every secret here is listed in docs/SECRETS.md.
# Values with spaces go in double quotes.

# ---- Release: the images to run (RELEASE.md). v1.2.3, or sha-<7 hex> of a
# main build. bootstrap.sh keeps /opt/dukaanai on the same commit.
IMAGE_REGISTRY=ghcr.io/shoryabansalgithub
IMAGE_TAG=
COMPOSE_FILE=$COMPOSE_FILES

# ---- Addresses (DNS A records to the VM's public IP, the deployment output).
# WEB_HOST=app.<your-domain>, API_HOST=api.<your-domain>,
# WEB_ORIGIN=https://app.<your-domain>, API_PUBLIC_URL=https://api.<your-domain>/api
WEB_HOST=
API_HOST=
WEB_ORIGIN=
API_PUBLIC_URL=
# Blank: Caddy gets public certificates (DNS must point here, 80/443 open).
EDGE_TLS_LINE=
TRUST_PROXY=1

# ---- Generated secrets (openssl rand). Changing one is a rotation: follow
# docs/SECRETS.md.
JWT_SECRET=${v[JWT_SECRET]}
NEXTAUTH_SECRET=${v[NEXTAUTH_SECRET]}
METRICS_TOKEN=${v[METRICS_TOKEN]}
GRAFANA_ADMIN_PASSWORD=${v[GRAFANA_ADMIN_PASSWORD]}

# ---- Azure Database for MySQL (the deployment outputs mysqlFqdn and
# mysqlAdminUser; the admin password is the one you gave the deployment).
# The admin account only creates the two users below; the API connects as
# MYSQL_USER, the backup jobs as dukaanai_backup, both over verified TLS.
AZURE_MYSQL_HOST=
AZURE_MYSQL_ADMIN_USER=
AZURE_MYSQL_ADMIN_PASSWORD=
MYSQL_DATABASE=dukaanai
MYSQL_USER=dukaanai
MYSQL_PASSWORD=${v[MYSQL_PASSWORD]}
MYSQL_BACKUP_PASSWORD=${v[MYSQL_BACKUP_PASSWORD]}
DB_CA_FILE=$CA_FILE
# DATABASE_URL and DB_OPS_DATABASE_URL are appended by bootstrap.sh once
# AZURE_MYSQL_HOST is filled in.
$(derived_lines v DATABASE_URL DB_OPS_DATABASE_URL)

# ---- Redis on this VM, on the private data network.
REDIS_PASSWORD=${v[REDIS_PASSWORD]}
$(derived_lines v REDIS_URL)

# ---- Data on this VM's disk (created by bootstrap.sh).
STORAGE_PATH=$DATA_ROOT/storage
UPLOADS_PATH=$DATA_ROOT/uploads
BACKUPS_PATH=$DATA_ROOT/backups

# ---- Off-site copies, encrypted on this VM before they leave it.
# COPY OFFSITE_CRYPT_PASSWORD AND OFFSITE_CRYPT_SALT INTO A PASSWORD MANAGER:
# without them every off-site copy is unreadable.
OFFSITE_CRYPT_PASSWORD=${v[OFFSITE_CRYPT_PASSWORD]}
OFFSITE_CRYPT_SALT=${v[OFFSITE_CRYPT_SALT]}
OFFSITE_KEEP_DAYS=30
OFFSITE_HOURLY_KEEP_DAYS=3
# Backblaze B2 through its S3 API: OFFSITE_REMOTE=b2:<bucket>/dukaanai, an
# application key limited to that bucket (read, write, delete): its keyID as
# ACCESS_KEY_ID, the key as SECRET_ACCESS_KEY, the bucket's region in
# REGION (e.g. us-west-004) and ENDPOINT (https://s3.<region>.backblazeb2.com).
OFFSITE_REMOTE=
RCLONE_CONFIG_B2_TYPE=s3
RCLONE_CONFIG_B2_PROVIDER=Other
RCLONE_CONFIG_B2_NO_CHECK_BUCKET=true
RCLONE_CONFIG_B2_ENDPOINT=
RCLONE_CONFIG_B2_REGION=
RCLONE_CONFIG_B2_ACCESS_KEY_ID=
RCLONE_CONFIG_B2_SECRET_ACCESS_KEY=

# ---- Backups on this VM: hourly dumps (keep 48) besides the nightly set.
BACKUP_LOOP_HOURLY_SECONDS=3600
BACKUP_HOURLY_KEEP=48

# ---- Email: smtp://<login>:<smtp-key>@<relay>:587 and the sender, e.g.
# EMAIL_FROM="DukaanAI <no-reply@<your-domain>>".
SMTP_URL=
EMAIL_FROM=

# ---- Optional: blank switches the feature off.
GEMINI_API_KEY=
ALERT_EMAIL_TO=
SENTRY_DSN=
EOF
}

# A key the file lacks is appended (a newer bootstrap.sh's key, or a derived
# URL whose inputs were filled in); no line already there is ever edited.
step_settings() {
  local dir rendered key appended=()
  dir="$(dirname "$ENV_FILE")"
  install -d -m 0700 -o root -g root "$dir"
  rendered="$(render_settings)"
  if [ ! -f "$ENV_FILE" ]; then
    (umask 077; printf '%s\n' "$rendered" >"$ENV_FILE.tmp.$$")
    mv "$ENV_FILE.tmp.$$" "$ENV_FILE"
    ENV_CREATED=1
    changed "settings file $ENV_FILE created with generated secrets"
  else
    while IFS= read -r key; do
      env_has "$key" && continue
      grep -m1 -E "^$key=" <<<"$rendered" >>"$ENV_FILE"
      appended+=("$key")
    done < <(printf '%s\n' "$rendered" | sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p')
    if [ "${#appended[@]}" -gt 0 ]; then
      changed "settings file: appended ${appended[*]} (existing lines untouched)"
    else
      already "settings file $ENV_FILE (never overwritten)"
    fi
  fi
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

check_settings() {
  local key value want
  for key in "${OWNER[@]}" "${GENERATED[@]}"; do
    [ -n "$(env_value "$key")" ] || MISSING+=("$key")
  done
  for key in "${DERIVED[@]}"; do
    value="$(env_value "$key")"
    want="$(derived_value "$key")"
    [ -n "$want" ] || continue
    [ "$value" = "$want" ] \
      || MISSING+=("$key (does not match AZURE_MYSQL_HOST and the passwords: delete its lines and run again to rebuild it)")
  done
  value="$(env_value IMAGE_TAG)"
  case "$value" in ""|v*|sha-*) ;; *) MISSING+=("IMAGE_TAG (v1.2.3 or sha-<7 hex>, not '$value')") ;; esac
  for key in WEB_ORIGIN API_PUBLIC_URL; do
    value="$(env_value "$key")"
    case "$value" in ""|https://*) ;; *) MISSING+=("$key (https://..., not '$value')") ;; esac
  done
  # The server certificate names *.mysql.database.azure.com: sslaccept=strict
  # refuses an IP address or the privatelink name.
  value="$(env_value AZURE_MYSQL_HOST)"
  [ -z "$value" ] || [[ "$value" =~ ^[a-z0-9][a-z0-9-]*\.mysql\.database\.azure\.com$ ]] \
    || MISSING+=("AZURE_MYSQL_HOST (the mysqlFqdn output, <server>.mysql.database.azure.com, not '$value')")
  value="$(env_value AZURE_MYSQL_ADMIN_PASSWORD)"
  [ -z "$value" ] || [[ "$value" =~ ^[A-Za-z0-9._~-]+$ ]] \
    || MISSING+=("AZURE_MYSQL_ADMIN_PASSWORD (letters, digits and ._~- only: it goes into a URL unescaped)")
  for key in "${OPTIONAL[@]}"; do
    [ -n "$(env_value "$key")" ] || note "$key is blank: that feature is off"
  done
}

# ---------------------------------------------------------------- start

step_start() {
  local stack="$CHECKOUT/$TARGET/stack.sh"
  [ -f "$stack" ] || die "$stack does not exist at this ref"
  log "starting the stack: $stack up"
  (cd "$CHECKOUT" && DUKAANAI_ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILES" bash "$stack" up)
  changed "stack.sh up finished"
}

# ---------------------------------------------------------------- summary

summary() {
  local line
  printf '\n==== DukaanAI host bootstrap: %s\n' "$(hostname)"
  if [ "${#CHANGED[@]}" -gt 0 ]; then
    printf 'Changed this run:\n'
    for line in "${CHANGED[@]}"; do printf '  + %s\n' "$line"; done
  fi
  if [ "${#ALREADY[@]}" -gt 0 ]; then
    printf 'Already in place:\n'
    for line in "${ALREADY[@]}"; do printf '  = %s\n' "$line"; done
  fi
  if [ "${#NOTES[@]}" -gt 0 ]; then
    printf 'Notes:\n'
    for line in "${NOTES[@]}"; do printf '  ! %s\n' "$line"; done
  fi
  if [ "${#MISSING[@]}" -gt 0 ]; then
    printf '\nWaiting for you. Fill these in %s, then run this script again:\n' "$ENV_FILE"
    for line in "${MISSING[@]}"; do printf '  - %s\n' "$line"; done
  fi
  printf '\nOFFSITE_CRYPT_PASSWORD and OFFSITE_CRYPT_SALT in %s encrypt every off-site\n' "$ENV_FILE"
  printf 'copy. %s them into your password manager now: if they are lost, every\n' "$([ "$ENV_CREATED" = 1 ] && echo 'Copy' || echo 'Make sure you copied')"
  printf 'backup at B2 is unreadable.\n'
}

# ---------------------------------------------------------------- main

main() {
  ORIGINAL_ARGS=("$@")
  # What bash parsed, to tell whether the checkout brought a different bootstrap.sh.
  SELF_SUM="$(sha256sum <"$0")"
  parse_args "$@"
  preflight
  take_lock
  if [ "$ENV_ONLY" = 1 ]; then
    step_settings
    check_settings
    summary
    [ "${#MISSING[@]}" -eq 0 ] || exit 3
    return 0
  fi
  step_base_packages
  step_checkout
  reexec_if_newer
  step_docker
  step_docker_logs
  step_time_sync
  step_firewall_check
  step_updates
  step_swap
  step_sysctl
  step_data_dirs
  step_db_ca
  step_settings
  check_settings
  if [ "${#MISSING[@]}" -gt 0 ]; then
    summary
    exit 3
  fi
  if [ "$NO_START" = 1 ]; then
    note "--no-start: the stack was not started ($TARGET/stack.sh up)"
  else
    step_start
  fi
  summary
}

# The whole file is parsed before anything runs, so a checkout that rewrites
# this file under a running bash cannot change what the rest of the run does.
main "$@"
exit
