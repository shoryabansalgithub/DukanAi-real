#!/bin/sh
# Renders alertmanager.yml.tmpl from the ALERT_* environment (roadmap 9.10).
# POSIX sh + sed only: it runs inside the prom/alertmanager image (busybox).
#
#   render.sh [--out FILE] [--secrets DIR] [--exec]
#     --out      where to write the rendered file (default /alertmanager/alertmanager.yml)
#     --secrets  where to write the secret files the config reads (default /alertmanager/secrets)
#     --exec     then exec Alertmanager on the rendered file (the compose entrypoint)
#
# A receiver block is enabled when its variable is set (ALERT_EMAIL_TO,
# ALERT_SLACK_WEBHOOK_URL, ALERT_PAGERDUTY_ROUTING_KEY); with none set the
# receivers are empty and every alert is dropped: the start-up line says so.
set -eu
TEMPLATE="$(dirname "$0")/alertmanager.yml.tmpl"
OUT=/alertmanager/alertmanager.yml
SECRETS=/alertmanager/secrets
EXEC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --secrets) SECRETS="$2"; shift 2 ;;
    --exec) EXEC=1; shift ;;
    *) echo "render.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

NL="$(printf '\nx')"; NL="${NL%x}"
check() { case "$2" in *'|'*|*"$NL"*) echo "render.sh: $1 must not contain '|' or a newline" >&2; exit 2 ;; esac; }
EMAIL_TO="${ALERT_EMAIL_TO:-}";               check ALERT_EMAIL_TO "$EMAIL_TO"
EMAIL_FROM="${ALERT_EMAIL_FROM:-alerts@dukaanai.local}"; check ALERT_EMAIL_FROM "$EMAIL_FROM"
SMARTHOST="${ALERT_SMTP_SMARTHOST:-localhost:25}"; check ALERT_SMTP_SMARTHOST "$SMARTHOST"
SMTP_USER="${ALERT_SMTP_USERNAME:-}";          check ALERT_SMTP_USERNAME "$SMTP_USER"
SMTP_TLS="${ALERT_SMTP_REQUIRE_TLS:-true}"
SLACK_URL="${ALERT_SLACK_WEBHOOK_URL:-}"
SLACK_CHANNEL="${ALERT_SLACK_CHANNEL:-#ops-alerts}"; check ALERT_SLACK_CHANNEL "$SLACK_CHANNEL"
PD_KEY="${ALERT_PAGERDUTY_ROUTING_KEY:-}"
TZ_NAME="${ALERT_TIMEZONE:-Asia/Kolkata}";     check ALERT_TIMEZONE "$TZ_NAME"
case "$SMTP_TLS" in true|false) ;; *) echo "render.sh: ALERT_SMTP_REQUIRE_TLS must be true or false" >&2; exit 2 ;; esac

mkdir -p "$SECRETS" "$(dirname "$OUT")"
umask 077
# The secret files always exist (an unset one is empty) so a rendered config
# never names a missing file; the block that reads it is only enabled when
# the value is set.
printf '%s' "${ALERT_SMTP_PASSWORD:-}" > "$SECRETS/smtp-password"
printf '%s' "$SLACK_URL" > "$SECRETS/slack-webhook"
printf '%s' "$PD_KEY" > "$SECRETS/pagerduty-routing-key"
umask 022

# `#@name ` lines: strip the marker when on, drop the line when off.
toggle() {
  if [ "$2" = 1 ]; then sed "s/^\([[:space:]]*\)#@$1 /\1/"; else sed "/^[[:space:]]*#@$1 /d"; fi
}
email_on=0; [ -n "$EMAIL_TO" ] && email_on=1
slack_on=0; [ -n "$SLACK_URL" ] && slack_on=1
pd_on=0;    [ -n "$PD_KEY" ] && pd_on=1
auth_on=0;  [ -n "$SMTP_USER" ] && auth_on=1

sed -e "s|__ALERT_SMTP_SMARTHOST__|$SMARTHOST|g" \
    -e "s|__ALERT_EMAIL_FROM__|$EMAIL_FROM|g" \
    -e "s|__ALERT_EMAIL_TO__|$EMAIL_TO|g" \
    -e "s|__ALERT_SMTP_USERNAME__|$SMTP_USER|g" \
    -e "s|__ALERT_SMTP_REQUIRE_TLS__|$SMTP_TLS|g" \
    -e "s|__ALERT_SLACK_CHANNEL__|$SLACK_CHANNEL|g" \
    -e "s|__ALERT_TIMEZONE__|$TZ_NAME|g" \
    -e "s|__SECRETS_DIR__|$SECRETS|g" "$TEMPLATE" \
  | toggle email "$email_on" | toggle slack "$slack_on" | toggle pagerduty "$pd_on" | toggle smtpauth "$auth_on" \
  > "$OUT"

receivers=""
[ "$email_on" = 1 ] && receivers="$receivers email($EMAIL_TO)"
[ "$slack_on" = 1 ] && receivers="$receivers slack($SLACK_CHANNEL)"
[ "$pd_on" = 1 ] && receivers="$receivers pagerduty"
if [ -z "$receivers" ]; then
  echo "render.sh: WARNING no ALERT_EMAIL_TO, ALERT_SLACK_WEBHOOK_URL or ALERT_PAGERDUTY_ROUTING_KEY is set: alerts are evaluated but delivered to nobody" >&2
else
  echo "render.sh: alert delivery:$receivers; critical pages ${pd_on:+the on-call}; warnings held out of hours ($TZ_NAME)" >&2
fi
echo "render.sh: wrote $OUT" >&2

if [ "$EXEC" = 1 ]; then
  exec /bin/alertmanager --config.file="$OUT" --storage.path=/alertmanager/data ${ALERTMANAGER_EXTERNAL_URL:+--web.external-url="$ALERTMANAGER_EXTERNAL_URL"}
fi
