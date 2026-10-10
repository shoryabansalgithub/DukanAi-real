# Backups and restore

Roadmap 7.7, 9.2, 9.3 and 9.4. The procedures for the database copy, the
documents copy and the off-site copy. What must survive, the
recovery objectives per store, the full data inventory (documents, product
images, Redis, secrets, browser state), the measured restore times and the
gaps still open are in `docs/DATA_SAFETY.md` (roadmap 9.1); this file says
how to take and restore the database backup. Everything here is in
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
  trailer, renamed to `DIR/<db>-<UTC stamp>[-label].sql.gz`, and two
  sidecars are written: `<name>.sha256`, and `<name>.meta` with the database,
  the snapshot time and the binary-log coordinates. A dump that stops early
  is never kept.
- Binary-log coordinates (roadmap 9.2): when the server writes a binary log
  (MySQL 8 default), the dump records the file and position of its snapshot
  (`--source-data=2`; `--master-data=2` on clients older than 8.0.26 and on
  MariaDB) as a comment in its first lines and in `.meta`, and
  `restore.sh --to` rolls the dump forward from exactly there. mysqldump
  holds a global read lock for a moment to pin them, which needs RELOAD and
  REPLICATION CLIENT: a user without them fails the backup with that hint,
  and `--coordinates skip` dumps without a position (no point-in-time
  restore from that dump). With binary logging off the dump says so and
  carries none.
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
  TABLES, plus RELOAD and REPLICATION CLIENT for the coordinates. The
  compose `db-ops` service connects as root for that reason; the `dukaanai`
  application user has ALL on its own database and nothing global.

With compose:

```
docker compose --profile ops run --rm db-ops backup                   # into the db-backups volume
docker compose --profile ops run --rm db-ops backup --label pre-1.4.0
docker compose --profile ops run --rm db-ops binlog-archive --flush   # the binary logs since the last run
docker compose --profile ops run --rm db-ops list                     # dumps and the archive
```

In the production topology (`docker-compose.prod.yml`, `deploy/k8s`;
roadmap 9.7) no cron exists: the `backup-agent` service, or the sidecar of
the API pod, runs `db-ops backup-loop`, which every
`BACKUP_LOOP_INTERVAL_SECONDS` (a day; first run
`BACKUP_LOOP_INITIAL_DELAY_SECONDS` after boot) takes the dump, the
documents archive and, with `OFFSITE_REMOTE` set, the off-site copy, logs a
failed job and runs the next, and stamps each success for the backup
metric. Against a managed MySQL the dump records its binary-log position
when `DB_OPS_DATABASE_URL` names a user with RELOAD + REPLICATION CLIENT
(otherwise `BACKUP_COORDINATES=skip`); point in time is the provider's
there and the binary-log archiver is not run. `db-ops status` shows the
agent's last successes.

On the reference stack, schedule the dump nightly (the retention sweep runs at 03:30, so 02:00 keeps
the two apart) and the binary-log archive every five minutes from the host's
cron, or run the archive as the `binlog-archiver` service, which does the
same without cron, and copy the volume off the host, e.g.:

```
0 2 * * *    cd /srv/dukaanai && docker compose --profile ops run --rm db-ops backup                  # dump
*/5 * * * *  cd /srv/dukaanai && docker compose --profile ops run --rm db-ops binlog-archive --flush  # binary logs
10 2 * * *   cd /srv/dukaanai && docker compose --profile ops run --rm db-ops documents-backup        # evidence + images (9.3)
30 2 * * *   cd /srv/dukaanai && docker compose --profile ops run --rm db-ops offsite push            # encrypted copy elsewhere (9.4)
docker compose --profile ops up -d binlog-archiver     # instead of the */5 line: every BINLOG_ARCHIVE_INTERVAL_SECONDS (300)
```

A backup that lives only on the database host is not a backup: the last
line ships everything in the volume to object storage in another account,
encrypted ("Off-site copies" below). `db-ops status` shows every job's last
success; the API turns the same stamps into a metric and an alert ("Backup
monitoring" below).

## Binary-log archive (point in time, roadmap 9.2)

```
scripts/db/binlog-archive.sh [--out DIR] [--flush] [--keep-days N]
```

The dump is the state at one moment; the binary log is every change since.
`binlog-archive.sh` copies the server's closed binary logs into an archive
directory next to the dumps (`BINLOG_ARCHIVE_DIR`, else `BACKUP_DIR/binlog`),
so `restore.sh --to` can roll any dump forward to any second the archive
covers. Run it every few minutes: the recovery point is the interval.

- The logs are read over the connection with `mysqlbinlog
  --read-from-remote-server --raw` (no access to the data directory; needs
  REPLICATION SLAVE and REPLICATION CLIENT), written as `.inflight.<name>`,
  kept only when the size equals the one the server reports, then renamed
  next to a `.sha256` sidecar. A log already in the archive with the right
  size is skipped, so a run is idempotent, and a log the server has purged
  but the archive holds stays: the archive is the long memory, the server
  keeps 7 days (`binlog_expire_logs_seconds=604800` in `docker-compose.yml`;
  MySQL's default is 30).
- `--flush` runs `FLUSH BINARY LOGS` first (needs RELOAD), so the log being
  written is closed and archived too. Without it the open log waits until
  the server rotates it at `max_binlog_size` (1 GB), which on a quiet shop is
  days away: the cron line always passes `--flush`. A continuous alternative
  is `mysqlbinlog --read-from-remote-server --raw --stop-never` as a
  supervised daemon; the cron is simpler and its lag is bounded.
- `--keep-days N` (default 7) removes logs archived more than N days ago.
  Keep it above the dump interval, or a dump has no logs to roll forward
  with; the point-in-time window is the shorter of the two retentions.
- `.last-success` in the archive holds the UTC time of the last run and the
  newest archived log; the stale-backup alert of roadmap 9.4 reads it.
- A MariaDB `mysqlbinlog` cannot read MySQL 8 logs: point `MYSQLBINLOG_BIN`
  at the MySQL 8 client. Encrypted binary logs (`binlog_encryption`) are
  refused: a raw copy cannot be replayed without the key.

## Documents: the storage root and product images (roadmap 9.3)

```
scripts/storage/backup.sh --root DIR [--media DIR] [--out DIR] [--keep N] [--label TEXT]
scripts/storage/restore.sh ARCHIVE.tar.gz --to DIR | --root DIR [--media DIR]   [--yes] [--overwrite]
scripts/storage/restore-drill.sh --root DIR [--media DIR]
```

The dump holds no file: billing evidence, captured bills, statements and
customer files live under `STORAGE_ROOT`, product images under
`uploads/media` (the files `MediaStorage.cdnUrl` rows point at). `backup.sh`
writes one `documents-<UTC stamp>[-label].tar.gz` with the two trees as
`storage/` and `media/` (GNU tar, `--dereference` over a staging directory
of symlinks, sorted members), next to three sidecars: `.sha256` of the
archive, `.manifest` with the SHA-256 of every file (`sha256sum` format), and
`.meta` (roots, time, file count). It is written as `.partial` and renamed,
the oldest archives are pruned (`--keep`, default 14), and the success is
recorded for monitoring. Evidence files are written once and never replaced
(roadmap 7.5), so an archive taken while the API runs is consistent; a file
that changes while tar reads it fails the run and the next run succeeds.

`restore.sh` verifies the `.sha256` sidecar before writing anything, extracts
either the whole archive into one directory (`--to`, a drill or a new
volume) or each tree onto its volume (`--root`, `--media`), and then verifies
every restored file against the manifest, so a passing restore is byte
for byte what was archived. A destination must be empty unless
`--overwrite` is given (files in the archive replace same-named files;
everything else stays), because a restore over a live volume is a
deliberate act. The dry run prints the plan.

With compose, where `db-ops` mounts the two volumes read-only at
`/data/storage` and `/data/uploads`:

```
docker compose --profile ops run --rm db-ops documents-backup                       # into /backups/documents
docker compose --profile ops run --rm db-ops documents-restore /backups/documents/<file>.tar.gz --to /backups/restore-check --yes
# onto the live volumes (API stopped): mount them writable for that one run
docker compose stop api
docker compose --profile ops run --rm -v dukaanai_api-storage:/restore/storage -v dukaanai_api-uploads:/restore/uploads db-ops \
  documents-restore /backups/documents/<file>.tar.gz --root /restore/storage --media /restore/uploads/media --overwrite --yes
docker compose start api
```

The drill backs the trees up, restores the archive into a temporary
directory, checks every restored file against the manifest, compares a
fresh manifest of the source with a fresh manifest of the restore (every
source file present with the same SHA-256, nothing else), and checks one
file byte for byte. CI runs it in the "Integration tests (MySQL 8 + Redis)"
job on the evidence the suites wrote, on every push.

### Documents rehearsal record

The local storage root of the integration suites plus the product images
directory:

```
==> 1/4 Documents backup of apps/api/data/storage and apps/api/uploads/media
==> Documents backup written: .../documents-20261005T173110Z-drill.tar.gz (12K, 81 files; .sha256, .manifest and .meta sidecars)
==> 2/4 Restore into /tmp/.../restore
==> Restored 81 files, every checksum identical to the manifest, in 0s
==> 3/4 Every source file is in the restore with the same SHA-256, and nothing else is
  81 files, 304169 bytes, identical
==> 4/4 A single file restored from the archive is byte-identical
  media/49/497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581.png: identical
DOCUMENTS RESTORE DRILL PASSED: 81 files / 304169 bytes ..., archive 12K, every checksum identical, 0s
```

The refusals were exercised: a non-empty destination without `--overwrite`,
a damaged `.sha256`, and a file altered after the restore (the manifest
check reports it).

## Off-site copies (roadmap 9.4)

```
scripts/backup/offsite.sh push | check | list | fetch DIR [--only GLOB]
scripts/backup/offsite-drill.sh --root DIR [--media DIR]
```

`push` copies the whole backup directory (dumps and sidecars, the binary-log
archive, the documents archives, the status stamps; in-flight and dot files
excluded) to `OFFSITE_REMOTE` through rclone's `crypt` backend, verifies
every file against its encrypted copy with `rclone cryptcheck`, prunes
remote files older than `OFFSITE_KEEP_DAYS` (30) and records the success.
File names and contents are encrypted on the way; a listing of the bucket
shows nothing readable. `fetch DIR` brings everything (or `--only` a
pattern) back, decrypted, for a restore on any machine that has rclone, the
scripts and the key. `check` and `list` are the read-only views.

Configuration is environment only, no `rclone.conf` with the key in it:

| Variable | Meaning |
|---|---|
| `OFFSITE_REMOTE` | an rclone path on the target: `s3:bucket/dukaanai`, `b2:bucket/dukaanai`, `r2:bucket/dukaanai`, `gcs:bucket/dukaanai`; `local:/mnt/offsite` for a drill or a mounted drive |
| `OFFSITE_CRYPT_PASSWORD` | the encryption key, 32+ characters, from the secret store; losing it loses every off-site copy |
| `OFFSITE_CRYPT_SALT` | an optional second key (recommended), same rules |
| `OFFSITE_KEEP_DAYS` | remote retention on push (30; 0 keeps all) |
| `RCLONE_CONFIG_<NAME>_*` | the backend behind the remote name, e.g. `RCLONE_CONFIG_S3_TYPE=s3`, `RCLONE_CONFIG_S3_PROVIDER=AWS`, `RCLONE_CONFIG_S3_REGION=ap-south-1`, `RCLONE_CONFIG_S3_ACCESS_KEY_ID`, `RCLONE_CONFIG_S3_SECRET_ACCESS_KEY`; Cloudflare R2: `TYPE=s3 PROVIDER=Cloudflare ENDPOINT=https://<account>.r2.cloudflarestorage.com`; Backblaze B2: `RCLONE_CONFIG_B2_TYPE=b2 ACCOUNT KEY`; Google Cloud Storage: `RCLONE_CONFIG_GCS_TYPE=google cloud storage` with a service account file |

Pick a bucket in another region and another account than the servers
(a provider backup in the same account dies with the account), with
versioning or object lock on if the provider offers it, and a key that is
not stored next to the data. In compose the four `OFFSITE_*` variables come
from `.env` into the `db-ops` service; `db-ops offsite push` refuses with the
reason while they are blank.

The drill (`offsite-drill.sh`) makes a fresh backup set (dump with its
binary-log position, binary-log archive, documents archive), pushes it,
proves the bucket holds only encrypted names and contents (no backup file
name appears, a `CREATE TABLE` line of the dump and a line of the manifest
are not found in the bucket), fetches everything into an empty workspace as
a clean machine would, verifies every `.sha256` sidecar, restores the
documents archive with every checksum identical, and restores the dump into
a scratch database with the source's migration count. With
`OFFSITE_REMOTE=local:<dir>` it needs no cloud account and runs the same
code path; CI runs it that way in the integration job on every push, and
the compose smoke pushes to a local remote through the `db-ops` image.

### Off-site rehearsal record

Local MySQL 8.0.46, rclone 1.60.1, a local remote:

```
==> 1/7 A fresh backup set: dump, binary-log archive, documents archive
  80 files to ship
==> 2/7 Ship it: offsite.sh push to local:/.../bucket
==> Off-site copy: /tmp/.../backups -> local:/.../bucket (encrypted)
==> Verifying every local file against its encrypted copy (rclone cryptcheck)
==> Off-site copy complete: local:/.../bucket holds Total objects: 84 (84) Total size: 531.399 MiB
==> 3/7 The bucket holds nothing readable
  84 encrypted objects, no readable name among them
  the dump text and the manifest text are not in the bucket
==> 4/7 A clean machine: fetch everything into an empty workspace
==> Fetched 84 file(s) into /tmp/.../clean; verify the .sha256 sidecars before restoring (sha256sum -c)
==> 5/7 Every fetched .sha256 sidecar verifies
  39 sidecars verified
==> 6/7 The fetched documents archive restores with every checksum identical
==> Restored 81 files, every checksum identical to the manifest, in 0s
==> 7/7 The fetched dump restores into dukaanai_smoke_offsite_... with the source's migration count
==> Restored 231 tables, 2 triggers, 21 applied migrations into dukaanai_smoke_offsite_... in 4s
OFF-SITE DRILL PASSED: 84 files shipped ... encrypted, fetched on a clean workspace, 39 sidecars verified, documents and database restored, 17s
```

The first attempt was refused by rclone: a crypt remote must wrap a
configured backend, so the scripts define `local` themselves and
`local:/dir` needs no configuration.

### Restoring on a clean machine

1. Install rclone and the MySQL 8 clients, check out the repository at the
   release that was running (the scripts and `prisma/` of that release).
2. Set `OFFSITE_REMOTE`, `OFFSITE_CRYPT_PASSWORD` (and the salt) and the
   backend variables from the secret store;
   `scripts/backup/offsite.sh fetch /restore` (or `--only 'documents/*'`,
   `--only '*.sql.gz*'`).
3. `sha256sum -c` every sidecar; then the database restore of this
   document, rolled forward with `--to` and `--binlogs /restore/binlog`
   when the archive came back; then `scripts/storage/restore.sh` onto the
   storage and media volumes; then `migrate status`, `migrate diff`, start
   the API, sign in, the dashboard.

## Backup monitoring (roadmap 9.4)

Every job records its last success as `<BACKUP_STATUS_DIR>/<kind>.last-success`
(`record_success` in `scripts/db/lib.sh`; the first line is the UTC time,
the second a detail; `BACKUP_STATUS_DIR` defaults to `BACKUP_DIR/status`):
`dump`, `binlog`, `documents`, `offsite`. `db-ops status` prints them. The
API mounts the backups volume read-only (`BACKUP_STATUS_DIR`,
`docker-compose.yml`) and turns the files into
`backup_last_success_timestamp_seconds{kind}` on every metrics scrape;
`deploy/prometheus/alerts.yml` raises `DukaanAiBackupStale` when a kind is
older than its objective (binary logs 15 minutes, the three nightly jobs
26 hours) and `DukaanAiBackupNeverRecorded` for a kind with no stamp at
all. `deploy/prometheus/alerts.test.yml` makes both fire in a drill
(`promtool test rules`, run by CI with the rule check). A stamp that cannot
be written never fails a backup: the alert fires instead, which is the
point. Runbook: `docs/OBSERVABILITY.md`.

## Restore

```
scripts/db/restore.sh BACKUP.sql.gz [--database NAME] [--create] [--yes]
                      [--to "YYYY-MM-DD HH:MM:SS"] [--binlogs DIR] [--replay-database NAME]
```

Without `--yes` the script verifies the checksum and prints the plan (file,
size, table count, the dump's database and snapshot time, its binary-log
position, and with `--to` the logs it would replay) and changes nothing.
With `--yes` it restores: the dump drops and re-creates every table it
contains, so the target is replaced, not merged. When the restoring user may
switch binary logging off for its session (SUPER or SYSTEM_VARIABLES_ADMIN),
the restore leaves no trace in the server's own binary log; otherwise it
says so and proceeds.

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
6. Prove the restored books (roadmap 9.5): from `apps/api` with
   `DATABASE_URL` on the restored database, `npm run reconcile -- --shop
   <shopId> --date <day>` for the shops and the day you restored (or, once
   the API is up, `POST /reconciliation/run { date }` as each shop's
   owner): every check must come out as it did on the source, CLEAN or,
   where the source already carried a known drift, the same drift. A
   point-in-time restore is reconciled for the day of `--to`. The drill
   below does this comparison automatically.

Point in time (`--to`): the dump is the state at the moment its snapshot
started. `--to "YYYY-MM-DD HH:MM:SS"` (UTC; `YYYY-MM-DDTHH:MM:SSZ` also)
replays the archived binary logs from the position the dump recorded up to
that second, so the recovery point is the archive interval, not the dump
interval. The archive (`--binlogs DIR`, default `BINLOG_ARCHIVE_DIR`, else
`binlog/` next to the dump) must hold the log the dump starts in and be
contiguous from there, every file with its checksum; the plan names what it
would apply. The replay is `mysqlbinlog --skip-gtids --start-position
--stop-datetime` under `TZ=UTC`, with `--rewrite-db='<source>-><target>'`
when the target database has another name than the source and
`--database=<target>` (mysqlbinlog applies the rewrite first, so the filter
names the rewritten database), piped into `mysql`; the first event at or
after `--to` is not applied. Executing the replayed BINLOG statements needs
BINLOG_ADMIN or REPLICATION_APPLIER on the restoring user. A `--to` before
the dump's snapshot is refused: that state is an older dump. Restoring under
another name is the normal case (restore next to the live database, verify,
switch `DATABASE_URL`); `--replay-database` exists for the drill, which
replays a scratch copy's events, and is never needed for a real restore.

With compose:

```
docker compose stop api
docker compose --profile ops run --rm db-ops restore /backups/<file>.sql.gz --yes
docker compose --profile ops run --rm db-ops restore /backups/<file>.sql.gz --database dukaanai_restored --create --yes --to "2026-10-05 16:40:00"
docker compose run --rm migrate          # no-op when the backup is current
docker compose start api
```

## Restore drill

```
DATABASE_URL=mysql://root:...@host:3306/dukaanai scripts/db/restore-drill.sh [--keep] [--pitr auto|require|skip]
```

Steps 1 to 6: back the database up, restore the file into
`<db>_drill_<stamp>` on the same server (the user needs `CREATE DATABASE`;
in compose that is the root user), prove `migrate status` is up to date and
`migrate diff` finds no difference, compare the row count of every table,
check the ledger triggers are present on `LedgerTransaction`. Steps 7 to 9
(roadmap 9.2): `pitr-markers.sh write` puts marker A into the scratch copy,
reads a target time from the server's clock and puts marker B after it;
`binlog-archive.sh --flush` archives the logs; the same backup is restored
into `<db>_pitr_<stamp>` with `--to <target time>` and
`--replay-database <scratch copy>`, and `pitr-markers.sh verify` proves it
holds A and not B while every other table equals the first copy (nothing
duplicated, nothing lost). Step 10 (roadmap 9.5): `npm run reconcile
--json` runs against the restored copy and against the source for the shop
of the newest invoice and today's business day; status, drift count, every
check and the summary must be identical (a drift the source carries is
preserved, a difference means the restore lost or changed a row); skipped
when the copy holds no invoice. Both scratch databases are dropped. `--pitr auto`
(default) skips steps 7 to 9 with the reason when the server writes no
binary log, the dump carries no position, mysqlbinlog is missing or the
user cannot switch session binary logging off; `require` fails instead,
which is what CI passes; `skip` never runs them. It fails when the source is
written to during the run (the counts differ), so run it against a quiet
source: CI runs it in the "Integration tests (MySQL 8 + Redis)" job after
the suites, on the data they wrote, on every push; in production run it in
a maintenance window or against a staging copy.

`scripts/db/pitr-markers.sh` is also the tool for a managed provider's
point-in-time restore (below): `write` on staging, the provider restores to
the printed target time, `verify` against the restored instance.

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

### Point-in-time rehearsal (roadmap 9.2)

Local MySQL 8.0.46, MySQL 8 clients, the integration database of an
earlier run (231 tables, 277,812 rows, 14 MB dump), `restore-drill.sh --pitr
require`:

```
==> 1/9 Backup of dukaanai_integ8 (127.0.0.1:3308, MySQL 8.0.46-0ubuntu0.24.04.4)
==> Backup written: .../dukaanai_integ8-20261005T165025Z-drill.sql.gz (14M; .sha256 and .meta sidecars; binary-log position binlog.000029:150876987, snapshot at 2026-10-05T16:50:25Z)
==> 2/9 Restore into scratch database dukaanai_integ8_drill_20261005165025
==> Restored 231 tables, 2 triggers, 21 applied migrations into dukaanai_integ8_drill_20261005165025 in 15s
==> 3/9 ... Database schema is up to date!
==> 4/9 ... No difference detected.
==> 5/9 Row counts: 231 tables, 277812 rows compared
==> 6/9 Ledger immutability triggers restored: source=2 restored=2
==> 7/9 Two writes after the backup in dukaanai_integ8_drill_20261005165025: marker A, a target time, marker B
  marker A written at 2026-10-05 16:51:10.899 UTC (server clock)
  marker B written at 2026-10-05 16:51:15.040 UTC (server clock)
==> 8/9 Archive the binary logs (binlog-archive.sh --flush)
  archived binlog.000001 (180 bytes) ... archived binlog.000029 (150878601 bytes)
==> Binary-log archive: archived 29 file(s), 0 already there, newest binlog.000029; the server is writing binlog.000030
==> 9/9 Restore the backup rolled forward to 2026-10-05 16:51:12 UTC into dukaanai_integ8_pitr_20261005165025: A present, B absent, every other table equal
  then replay 1 binary log(s) binlog.000029..binlog.000029 from position 150876987 up to 2026-10-05 16:51:12 UTC: the events of dukaanai_integ8_drill_20261005165025, rewritten to dukaanai_integ8_pitr_20261005165025
==> Restored 231 tables, 2 triggers, 21 applied migrations into dukaanai_integ8_pitr_20261005165025 in 15s
==> Replayed to 2026-10-05 16:51:12 UTC in 0s: dukaanai_integ8_pitr_20261005165025 is dukaanai_integ8_drill_20261005165025 as of that second
  marker A: 1 row(s) (written 2026-10-05 16:51:10.899 UTC); marker B: 0 row(s)
POINT-IN-TIME CHECK PASSED: dukaanai_integ8_pitr_20261005165025 holds the write before 2026-10-05 16:51:12 UTC and not the write after it
  231 tables, 277812 rows compared
RESTORE DRILL PASSED: ... point in time: marker before 2026-10-05 16:51:12 UTC kept, marker after it excluded, 231 tables equal (restore + replay 16s); 110s
```

The compose smoke (CI job "Deployment (compose smoke)", on every push)
proves the sentence of the roadmap literally: it takes a dump before the
sale, makes the sale through the API, archives the binary logs, restores
the dump alone (no invoice) and the dump rolled forward to now (the sale's
invoice number), and starts the `binlog-archiver` service. From the CI log
of commit 88ba0e2:

```
==> ops (roadmap 9.2): archive the binary logs, restore the pre-sale dump alone and rolled forward to now: only the latter holds sale INV-2026-27-000001
  the pre-sale dump holds no invoice; rolled forward to now it holds INV-2026-27-000001, the sale made after the dump
``` The same run
locally against the compose smoke database rolled a dump forward through
three archived logs and matched the source's counts. The refusals were
exercised too: a dump taken with `--coordinates skip` ("the
dump carries no binary-log position"), a `--to` before the snapshot, an
archive without the dump's first log, a gap in the archive (found by the
first attempt: a stray `binlog.000031.aside` passed the file listing and
hid the gap; the listing now accepts only `<prefix>.<digits>`), a damaged
`.sha256`, and a malformed `--to`.

### Reconciliation of the restored copy (roadmap 9.5)

Step 10 on the local MySQL 8.0.46 test database (232 tables, 25,491 rows,
22 migrations, `--pitr skip`), the same day the step was added:

```
==> 10/10 The restored copy's books reconcile exactly as the source's (npm run reconcile on dukaanai_test_drill_20261005185117 and dukaanai_test)
  books of shop cmuvlrb9700b27de47xn54fqs on 2026-10-06: CLEAN with 0 drift(s) on both sides (documents=CLEAN postings=CLEAN tenders=CLEAN dashboard=CLEAN shifts=CLEAN stock=CLEAN ledger=CLEAN)
RESTORE DRILL PASSED: dukaanai_test -> dukaanai_test_drill_20261005185117, backup 1.2M, 232 tables / 25491 rows, 2 triggers; point in time skipped (--pitr skip); books of shop ... CLEAN with 0 drift(s) on both sides (...); 45s
```

The comparison is of the whole run (status, drift count, every check's
figures and drifts, the summary), not of the status alone: a source that
carries a known drift must restore with exactly that drift. The CLI
records its run on both databases (trigger `CLI`), so the source keeps a
record that its books were compared.

## Managed MySQL: point-in-time recovery by the provider

Production runs on a managed MySQL 8 (`docs/DATA_SAFETY.md`, decisions).
There the provider keeps the binary logs and restores to a timestamp into a
new instance; the archive above is the self-hosted path, and the drill for
the provider path uses the same markers. To switch on when the instance
exists (owner, roadmap 9.2):

| Provider | Switch on | Point in time |
|---|---|---|
| AWS RDS for MySQL | automated backups with the longest retention (35 days), deletion protection, Multi-AZ | any second inside the retention, restored into a new instance |
| Google Cloud SQL for MySQL | automated backups, point-in-time recovery (binary logging) with the longest log retention offered, deletion protection, high availability | inside the log retention, into a new instance |
| Azure Database for MySQL flexible server | automated backups with retention up to 35 days, zone-redundant high availability | inside the retention, into a new server |
| DigitalOcean managed MySQL | daily backups are on; point-in-time recovery covers the last 7 days | into a new cluster forked at a timestamp |

The drill, on staging, before every go-live and then quarterly:

1. `DATABASE_URL=<staging> scripts/db/pitr-markers.sh write` prints
   `run=<id>` and `target_time=<UTC>`.
2. Restore the staging instance to the target time into a new instance
   with the provider's console or CLI. Note how long the provider took: it
   is the restore line of the RTO budget in `docs/DATA_SAFETY.md`.
3. `DATABASE_URL=<restored instance> scripts/db/pitr-markers.sh verify
   --run <id> --target-time <UTC> --cleanup` must print
   `POINT-IN-TIME CHECK PASSED`; then, from `apps/api` with the same URL,
   `npx prisma migrate status` and the migrate diff of the restore section;
   then `pitr-markers.sh cleanup` against staging drops the marker table
   there (staging holds both markers, so it cannot pass `verify`).
4. Delete the restored instance and record the result in
   `docs/DATA_SAFETY.md`, section 4.

A provider backup lives in the account it protects: keep the nightly
`backup.sh` dump in a bucket of another account as well (roadmap 9.4).

## Rollback of a release

`apps/api/prisma/MIGRATIONS.md`, "Rolling back a release": additive
migrations need no database step (redeploy the previous image), a data fix
is reversed by a forward migration, and only a destructive migration needs
the pre-release backup, which is why `DEPLOYMENT_CHECKLIST.md` has the
backup as the step before `migrate deploy`.

## What else to back up

- The storage volume (`STORAGE_ROOT`, compose volume `api-storage`) and
  the product images (`uploads/media` on the `api-uploads` volume): the
  documents backup above, nightly, shipped off-site with the dumps. The
  rest of the uploads volume (`imports`, `exports`, `tmp`) is reproducible
  and not archived.
- Secrets (`.env`): `JWT_SECRET` (a new one plus `sessions:revoke-all` ends
  every session), `NEXTAUTH_SECRET`, `METRICS_TOKEN`,
  `OFFSITE_CRYPT_PASSWORD` (without it the off-site copies are noise), SMTP
  and Google credentials. Keep them in the secret store, never with the
  dumps; the register and the rotation procedures are `docs/SECRETS.md`.
- Redis needs no backup: queues rebuild from the outbox, caches from the
  database, rate-limit counters and cron locks expire.
