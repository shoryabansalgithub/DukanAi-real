#!/usr/bin/env bash
# Self-test of scripts/db/lib.sh (no database needed):
#
#   bash scripts/db/lib.test.sh
#
# Percent-decoding of DATABASE_URL credentials (a '+' and a backslash stay
# what they are), the TLS settings a URL asks for and the client flags they
# become (verification is never dropped), and the owner-only umask every
# backup script inherits. Exit 0 when every check passes.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

failures=0
check() {
  if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: got [%s], want [%s]\n' "$1" "$2" "$3"; failures=$((failures + 1)); fi
}

check "urldecode keeps a plus" "$(urldecode 'a+b')" 'a+b'
check "urldecode keeps a backslash" "$(urldecode 'p\nq\\x41')" 'p\nq\\x41'
check "urldecode decodes percent escapes" "$(urldecode 'p%40ss%2Bw%25rd%5C')" 'p@ss+w%rd\'
check "urldecode decodes UTF-8 bytes" "$(urldecode '%E2%82%B9')" '₹'

ca="$(mktemp)"
trap 'rm -f "$ca"' EXIT
DATABASE_URL="mysql://u%2Bx:p%5Cn%2B@db.example.com:3307/dukaanai?connection_limit=5&sslaccept=strict&sslcert=$ca" load_connection
check "user" "$DB_USER" 'u+x'
check "password" "$DB_PASS" 'p\n+'
check "host, port, database" "$DB_HOST:$DB_PORT/$DB_NAME" 'db.example.com:3307/dukaanai'
check "strict means verify" "$DB_SSL_MODE" verify
check "the CA file" "$DB_SSL_CA" "$ca"
check "TLS query for derived URLs" "$DB_URL_TLS_QUERY" "sslaccept=strict&sslcert=$ca"
check "MySQL client verifies the identity" "$(MYSQL_BIN=/bin/false conn_args | tr '\n' ' ')" "--host=db.example.com --port=3307 --user=u+x --protocol=TCP --ssl-mode=VERIFY_IDENTITY --ssl-ca=$ca "
DATABASE_URL="mysql://u:p@10.0.0.5:3306/d?sslcert=$ca" load_connection
check "sslcert alone verifies; an IP host verifies the CA" "$(MYSQL_BIN=/bin/false tls_args | tr '\n' ' ')" "--ssl-mode=VERIFY_CA --ssl-ca=$ca "
DATABASE_URL="mysql://u:p@h:3306/d?sslaccept=accept_invalid_certs" load_connection
check "accept_invalid_certs only encrypts" "$(MYSQL_BIN=/bin/false tls_args | tr '\n' ' ')" "--ssl-mode=REQUIRED "
DATABASE_URL="mysql://u:p@h:3306/d?connection_limit=3" load_connection
check "no TLS parameter, no TLS flag" "$(MYSQL_BIN=/bin/false tls_args | tr '\n' ' ')" ""
fake_mariadb="$(mktemp)"; printf '#!/bin/sh\necho "mysql  Ver 15.1 Distrib 10.11.14-MariaDB"\n' > "$fake_mariadb"; chmod 700 "$fake_mariadb"
check "a MariaDB client verifies with its own flags" "$(DB_SSL_MODE=verify DB_SSL_CA=$ca tls_args "$fake_mariadb" | tr '\n' ' ')" "--ssl --ssl-verify-server-cert --ssl-ca=$ca "
rm -f "$fake_mariadb"
check "files are written owner-only" "$(umask)" 0077

[ "$failures" -eq 0 ] || { printf '%s check(s) failed\n' "$failures"; exit 1; }
printf 'lib.sh: every check passed\n'
