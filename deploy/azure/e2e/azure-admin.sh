#!/usr/bin/env bash
# The server admin of the Azure-like MySQL (deploy/azure/e2e.sh): the exact
# privilege list Azure Database for MySQL Flexible Server gives the admin it
# creates (learn.microsoft.com/azure/mysql/security/security-how-to-create-users),
# with GRANT OPTION and nothing else: no SUPER, no dynamic privilege such as
# SHOW_ROUTINE or SYSTEM_VARIABLES_ADMIN. db-init and the drills run as this
# account, so whatever they need beyond Azure's admin fails here too. Run by
# the mysql image on the first start of its data directory.
set -euo pipefail
case "$AZURE_MYSQL_ADMIN_USER" in *[!A-Za-z0-9_]*|"") echo "azure-admin.sh: AZURE_MYSQL_ADMIN_USER must be a plain identifier" >&2; exit 1 ;; esac
pw="${AZURE_MYSQL_ADMIN_PASSWORD//\\/\\\\}"; pw="${pw//\'/\\\'}"
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket -uroot <<SQL
CREATE USER '$AZURE_MYSQL_ADMIN_USER'@'%' IDENTIFIED BY '$pw';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, RELOAD, PROCESS, REFERENCES, INDEX, ALTER, SHOW DATABASES, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, REPLICATION SLAVE, REPLICATION CLIENT, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, CREATE USER, EVENT, TRIGGER ON *.* TO '$AZURE_MYSQL_ADMIN_USER'@'%' WITH GRANT OPTION;
SQL
echo "azure-admin.sh: '$AZURE_MYSQL_ADMIN_USER'@'%' created with the Azure admin's privileges"
