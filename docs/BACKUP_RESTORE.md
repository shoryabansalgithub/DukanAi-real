# Backups and restore (MySQL 8)

Roadmap 7.7. The database is the only state that matters: Redis holds
queued jobs and caches that rebuild themselves, the storage volume holds
billing evidence (back it up as files, see the end). Everything here is in
`scripts/db/` and runs wherever a MySQL 8 client is: on the host, in CI, or
in the compose stack through the `db-ops` service.

## Backup

```
scripts/db/backup.sh [--out DIR] [--keep N] [--label TEXT]
```

- Connection from `DATABASE_URL` as the API reads it
  (`mysql://user:pass@host:port/db?...`; the query string is ignored) or
  `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` /
  `MYSQL_DATABASE`. The password goes to the client through `MYSQL_PWD`,
  never on a command line.
- `mysqldump --single-transaction --quick --routines --triggers --events
  --hex-blob --no-tablespaces`: a consistent InnoDB snapshot without table
  locks, so the API keeps serving while it runs. `--set-gtid-purged=OFF` and
  `--column-statistics=0` are added when the client knows them (MySQL 8;
  a MariaDB client dumps a MySQL 8 server without them).
- The stream is written to `DIR/.<name>.partial`, checked for the dump
  trailer, renamed to `DIR/<db>-<UTC stamp>[-label].sql.gz`, and a
  `<name>.sha256` sidecar is written. A dump that stops early is never kept.
- `DEFINER` clauses are stripped so the ledger triggers restore under
  whichever user restores (a non-SUPER user cannot create a trigger with
  another definer), and a trigger body that MySQL 8 stored with its
  statement terminator is cleaned (see the finding below).
- `--keep N` (default 14, `0` keeps all) removes the oldest backups of the
  same database in `DIR`. The default `DIR` is `/var/backups/dukaanai`
  (`BACKUP_DIR`); the script refuses to run without a writable directory
  and never writes into the repository (`scripts/check-tracked-artifacts.sh`
  fails CI if a `.sql.gz` is ever committed).
- Needs on the database user: SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK
  TABLES (the compose `dukaanai` user has ALL on its database).

With compose:

```
docker compose --profile ops run --rm db-ops backup              # into the db-backups volume
docker compose --profile ops run --rm db-ops backup --label pre-1.4.0
docker compose --profile ops run --rm db-ops list
```

Schedule the first line from the host's cron (nightly is the floor; the
retention sweep runs at 03:30, so 02:00 keeps the two apart) and copy the
volume off the host, e.g.:

```
docker run --rm -v dukaanai_db-backups:/backups:ro -v /mnt/offsite:/out alpine \
  sh -c 'cp /backups/*.sql.gz /backups/*.sha256 /out/'
```

A backup that lives only on the database host is not a backup.

## Restore

```
scripts/db/restore.sh BACKUP.sql.gz [--database NAME] [--create] [--yes]
```

Without `--yes` the script verifies the checksum and prints the plan (file,
size, table count, target) and changes nothing. With `--yes` it restores:
the dump drops and re-creates every table it contains, so the target is
replaced, not merged.

Order of operations for a real restore:

1. Stop the API (`docker compose stop api`, or scale the deployment to 0):
   requests against a half-restored database would see missing tables.
2. Restore into a **fresh** database when possible
   (`--database dukaanai_restored --create --yes`), then point
   `DATABASE_URL` at it and start the API. The old database stays as
   evidence. Restoring over the live database (`--yes` without
   `--database`) is for when there is no room for a second copy.
3. From `apps/api`, with `DATABASE_URL` on the restored database:
   `npx prisma migrate status` must say "Database schema is up to date!"
   and `npx prisma migrate diff --from-url "$DATABASE_URL"
   --to-schema-datamodel prisma/schema.prisma --exit-code` must print
   "No difference detected". A backup from an older release carries fewer
   applied migrations: `migrate deploy` brings it to the current schema,
   then the API image of the current release runs; the backup's own
   release image is the alternative (`prisma/MIGRATIONS.md`, "Rolling back
   a release").
4. Start the API; `GET /api/health/ready` is 200; sign in; the dashboard
   loads; `outbox_rows{status="PENDING"}` (metrics) drains once the relays
   run: rows the restored database still holds as PENDING are delivered
   again, which the webhook consumers must tolerate (deliveries carry
   their event id).
5. Redis: nothing to restore, but a job queued before the restore may
   reference an outbox row the backup does not contain; such a job logs a
   "missing row" no-op and is dropped (`runInShopOf`).

Point in time: the dump is the state at the moment the backup started.
Writes after it are lost unless binary logs are kept and replayed
(`mysqlbinlog --start-position` from the dump's `-- CHANGE MASTER` /
`SHOW MASTER STATUS` note; not automated here). The recovery point is
therefore the backup interval; shorten it for a busier shop.

With compose:

```
docker compose stop api
docker compose --profile ops run --rm db-ops restore /backups/<file>.sql.gz --yes
docker compose run --rm migrate          # no-op when the backup is current
docker compose start api
```

## Restore drill

```
DATABASE_URL=mysql://root:...@host:3306/dukaanai scripts/db/restore-drill.sh [--keep]
```

Backs the database up, restores the file into `<db>_drill_<stamp>` on the
same server (the user needs `CREATE DATABASE`; in compose that is the root
user), proves `migrate status` is up to date and `migrate diff` finds no
difference, compares the row count of every table, checks the ledger
triggers are present on `LedgerTransaction`, and drops the scratch
database. It fails when the source is written to during the run (the
counts differ), so run it against a quiet source: CI runs it in the
"Integration tests (MySQL 8 + Redis)" job after the suites, on the data
they wrote, on every push; in production run it in a maintenance window or
against a staging copy.

### Rehearsal record

Local MySQL 8.0.46 (the production engine), the compose smoke database
(231 tables, 66 rows, 18 migrations), mysqldump / mysql 8.0 clients:

```
==> 1/6 Backup of dukaanai_smoke (127.0.0.1:3308, MySQL 8.0.46-0ubuntu0.24.04.4)
==> 2/6 Restore into scratch database dukaanai_smoke_drill_20261003163157
==> Verifying dukaanai_smoke-20261003T163157Z-drill.sql.gz.sha256
dukaanai_smoke-20261003T163157Z-drill.sql.gz: OK
==> Plan: restore dukaanai_smoke-20261003T163157Z-drill.sql.gz (36K, 231 tables) into dukaanai_smoke_drill_20261003163157 on 127.0.0.1:3308 as root
==> CREATE DATABASE IF NOT EXISTS dukaanai_smoke_drill_20261003163157
==> Restoring into dukaanai_smoke_drill_20261003163157
==> Restored 231 tables, 2 triggers, 18 applied migrations into dukaanai_smoke_drill_20261003163157 in 6s
==> 3/6 prisma migrate status on dukaanai_smoke_drill_20261003163157 (every migration applied, nothing pending)
18 migrations found in prisma/migrations
Database schema is up to date!
==> 4/6 prisma migrate diff: restored schema == prisma/schema.prisma
No difference detected.
==> 5/6 Row counts: every table of dukaanai_smoke has the same count in dukaanai_smoke_drill_20261003163157
  231 tables, 66 rows compared
==> 6/6 Ledger immutability triggers restored
  source=2 restored=2
RESTORE DRILL PASSED: dukaanai_smoke -> dukaanai_smoke_drill_20261003163157, backup 36K, 231 tables / 66 rows, 2 triggers, 35s
```

The first run of the drill **failed** at step 2:

```
ERROR 1064 (42000) at line 2013: You have an error in your SQL syntax; ... near ' */' at line 1
```

Prisma applies a migration to MySQL as one multi-statement script, and
MySQL 8 had stored the bare single-statement body of the
`prevent_ledger_update` trigger (`20260929090200`) together with its
terminator, `SIGNAL ... ;`. mysqldump wrote it as `... ; */;;`, which the
mysql client refuses. MariaDB stored the same migration without the
terminator, which is why no test had seen it. Two fixes, both kept:
`20261003090100_ledger_triggers_portable_bodies` recreates both triggers
with `BEGIN ... END` bodies (clean on both engines; the rule for every
future trigger is in `prisma/MIGRATIONS.md`), and `backup.sh` drops such a
terminator from the dump, so a backup taken **before** that migration is
applied (the pre-release backup of exactly the release that carries it)
restores too. That path was rehearsed as well: a scratch database with the
old trigger body, created through a multi-statement connection, was backed
up and restored, and the restored trigger fired
(`ERROR 1644 (45000): Ledger records are strictly immutable.`).

## Rollback of a release

`apps/api/prisma/MIGRATIONS.md`, "Rolling back a release": additive
migrations need no database step (redeploy the previous image), a data fix
is reversed by a forward migration, and only a destructive migration needs
the pre-release backup, which is why `DEPLOYMENT_CHECKLIST.md` has the
backup as the step before `migrate deploy`.

## What else to back up

- The storage volume (`STORAGE_ROOT`, compose volume `api-storage`):
  billing evidence written once and never replaced (roadmap 7.5). Copy it
  with the backups (`docker run --rm -v dukaanai_api-storage:/s:ro ... tar`).
- Secrets (`.env`): `JWT_SECRET` (a new one ends every session),
  `NEXTAUTH_SECRET`, `METRICS_TOKEN`, SMTP and Google credentials. Keep
  them in the secret store, not with the dumps.
- Redis needs no backup: queues rebuild from the outbox, caches from the
  database, rate-limit counters and cron locks expire.
