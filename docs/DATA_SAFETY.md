# Data safety: recovery objectives and the state of every copy

Roadmap 9.1. This document is the authority on what must survive, how much
may be lost, how fast service must be back, and what protects each store
today. The procedures live next to it (`docs/BACKUP_RESTORE.md`,
`docs/DEPLOYMENT.md`, `apps/api/prisma/MIGRATIONS.md`); this file says what
they must achieve and where they still fall short. It is reviewed at every
change to a data store, a backup script or a schedule, and at the release
that closes each gap listed in section 5.

Terms: **RPO** (recovery point objective) is the most data, measured in time,
that an incident may lose. **RTO** (recovery time objective) is the longest
the service may be unavailable while it is restored. Both are commitments
for production; staging gets the same mechanisms but no commitment.

## 1. Objectives

| Data class | RPO | RTO | Meaning for a shop |
|---|---|---|---|
| Database: every business record | 5 minutes | 1 hour | A crash at 17:00 loses at most the sales of the last five minutes; billing is back within the hour. |
| Documents: billing evidence, captured bills, statements, customer files, product images | 24 hours | 4 hours | A document captured yesterday survives; one captured minutes before the incident may have to be re-captured. |
| Secrets | 0 (never lost) | 15 minutes | Rotating a lost secret ends sessions, never data. |
| Redis: cache, counters, locks, queued jobs | no commitment | restart | Rebuilt from the database and the outbox; nothing a shop entered lives only there. |
| Code, migrations, images | 0 | redeploy | Git and the image registry hold every release. |

The database objective is stricter than the documents' because a sale exists
only as database rows (`Invoice`, `InvoiceItem`, ledger postings, stock
movements); the evidence files are copies of what the database already
proves. Section 5 states which objectives are met today and which rows of the
roadmap close the rest; until a row is closed, the figure in section 2 is
the real one.

## 2. Data inventory: where each store lives, what it holds, what protects it

The reference deployment is `docker-compose.yml` (volumes in brackets); a
managed deployment maps each store to the provider's equivalent
(`docs/DEPLOYMENT.md`).

| Store | What lives there | Protection today | Real RPO today | Objective |
|---|---|---|---|---|
| MySQL 8, `DATABASE_URL` [`mysql-data`] | All 230 Prisma models: shops, users and sessions (`RefreshToken`), products, stock (`InventoryItem`, ledger rows), invoices, returns, customers, udhar, payments, shifts, expenses, suppliers, procurement, the immutable ledger, outbox, audit log, notifications. Every row carries its `shopId`. | `scripts/db/backup.sh` (consistent InnoDB snapshot that records its binary-log position; `.sha256` and `.meta` sidecars; keep 14) nightly, `binlog-archive.sh --flush` every five minutes copying the closed binary logs next to the dumps, both run by the `db-ops` service (or the `binlog-archiver` service for the archive) into the `db-backups` volume on the same host; `restore.sh --to` rolls a dump forward to any second the archive covers; `restore-drill.sh --pitr require` proves the chain on every CI push and the compose smoke proves a sale made after a dump survives the roll-forward; `db-ops offsite push` ships the volume nightly, encrypted, to object storage elsewhere. | the archive interval, 5 minutes, where the archiver runs; the dump interval where only the dump runs | 5 minutes |
| Documents, `STORAGE_ROOT` [`api-storage`] | Per shop: `Customers/<customerId>/{Invoices,Bills,Statements,Profile,…}` (evidence written once with the `wx` flag and never replaced; a delete moves the file to `Deleted/`), `System/customer_index.json` and `invoice_registry.json` (indexes derived from the files), `Logs/` (the storage action log), `Backups/<type>/backup_<date>.zip` (the zip `POST /storage/backup` makes of the shop's own folders: it lands on the same volume, so it is an export, not a backup). | `scripts/storage/backup.sh` nightly (`db-ops documents-backup`): one archive of the storage root and `uploads/media` with a per-file SHA-256 manifest, keep 14, in the `db-backups` volume, shipped off-site with the dumps; `restore.sh` verifies every file against the manifest; `restore-drill.sh` runs in CI on every push. | the documents schedule, 24 hours, where the cron runs | 24 hours |
| Uploads [`api-uploads`, `apps/api/uploads`] | `media/`: product images and thumbnails; `MediaStorage.cdnUrl` and `MediaThumbnail.cdnUrl` point at them. `imports/`, `exports/`: import and export files. `tmp/` (`UPLOAD_TEMP_DIR`): upload staging, never older than a request. | `media/` is in the nightly documents archive above (the `db-ops` service mounts the volume read-only); `imports/`, `exports/` and `tmp/` are not archived. | 24 hours for `media/` where the cron runs | 24 hours for `media/`; `imports/`, `exports/` and `tmp/` are reproducible and excluded |
| Redis, `REDIS_URL` [`redis-data`, append-only] | Cache (`cache:*`), rate-limit counters, cron locks, BullMQ jobs, advisory stock keys, the search-history budget. | None, by design. Append-only mode lets queued jobs survive a restart. | not applicable | none |
| Secrets | `JWT_SECRET`, `NEXTAUTH_SECRET`, the database and Redis passwords, `SMTP_URL`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, `METRICS_TOKEN`, `SENTRY_DSN`, the off-site backend's `RCLONE_CONFIG_*` keys, `OFFSITE_CRYPT_PASSWORD` and salt (without them every off-site copy is noise); the full register with owners and rotation procedures is `docs/SECRETS.md` (roadmap 9.11). | The deployment's secret store or the host's `.env`; never inside a dump (`backup.sh` dumps data only); never in a committed file (gitleaks on every push). | not applicable | none |
| Browser | The POS cart (per tab and per shop in `sessionStorage`), the theme, a captured frame handed to the AI scanner. | None. A sale exists only once `POST /billing/invoice` has answered; an unsent cart is lost with the tab by design. | not applicable | none |
| Operational | JSON logs on stdout, Prometheus samples [`prometheus-data`], error tracking. | None; no customer data. | not applicable | none |
| Code and images | The repository, migrations, the two images. | GitHub and the image registry. | none | none |

What a Redis loss costs, precisely: caches rebuild on the next read, counters
and locks expire, and a job that was running is lost; the outbox row it had
claimed returns to PENDING after `EVENTS_OUTBOX_STALE_CLAIM_MS` (5 minutes)
through the reaper and is delivered again. Sessions are unaffected: refresh
tokens live in MySQL.

MySQL 8 writes a binary log by default; the compose server keeps seven days
of it (`binlog_expire_logs_seconds=604800`) and the archive is the long
memory. Every dump records the position it was taken at, so it rolls forward
to any second the archive covers (`docs/BACKUP_RESTORE.md`, "Binary-log
archive" and "Restore"). On a managed MySQL the provider's point-in-time
recovery replaces the archive; its settings and the drill against it are in
the same document and wait for the account.

## 3. What keeps the application itself from losing data

Backups answer disasters. These rules, all enforced in code and tests,
answer the everyday way data disappears: a bug or a user action.

- Business records are never hard-deleted: products, customers, suppliers,
  categories, locations and the procurement documents soft-delete with
  `isDeleted` and the `deletedToken` unique keys; `DELETE /shops` sets
  `status = DELETED` and keeps every row; returns and cancellations are new
  documents that reverse a sale, never an update of it.
- The ledger is immutable at the database (`prevent_ledger_update`,
  `prevent_ledger_delete` triggers, migration `20261003090100`); not even a
  test can change a posted row.
- Billing evidence is written once: a repeat answers 409
  `STORAGE_EVIDENCE_EXISTS` and nothing is replaced or partially written; a
  delete is a move into `Deleted/`.
- The retention sweep deletes only expired refresh and password-reset tokens
  (`RETENTION_EXPIRED_TOKENS_DAYS`, 7), DONE outbox rows (14 days), search
  history (90) and product event logs (180): never a business record.
- A migration never deletes rows on its own; a destructive change ships as
  expand then contract across two releases, and the pre-release backup is
  the step before `migrate deploy` (`DEPLOYMENT_CHECKLIST.md`).
- Every write is one transaction with a canonical lock order and the
  checkpoint fault-injection suite proves that a failure inside a sale,
  return, cancellation or repayment leaves nothing partial
  (`pos-failure-injection`).

## 4. Restore: who, how, how long

**Who.** Today the repository owner is the operator for every restore and
the only person who may order one; the on-call rota and the incident roles
are row 9.22. A restore needs database root (`CREATE DATABASE`), the host or
cluster access to stop and start the API, and the secret store.

**How.** `docs/BACKUP_RESTORE.md`, "Restore": stop the API; restore the
dump into a fresh database; if the dump is from an older release, run the
release step `prisma migrate deploy` on it; verify (`migrate status` up to
date, `migrate diff` clean, row counts, ledger triggers present: exactly what
`restore-drill.sh` automates); point `DATABASE_URL` at it; start the API;
readiness 200; sign in; dashboard loads; the outbox drains. Documents: copy
the archive back onto the volume, compare checksums, remount. A release
rollback that needs data back is the same procedure
(`apps/api/prisma/MIGRATIONS.md`, "Rolling back a release").

**How long, measured.** On this revision, local MySQL 8.0.46 (the production
engine), MySQL 8 clients, one CPU-constrained container:

| Step | Measured | Data |
|---|---|---|
| Dump + checksum | 5 s | `dukaanai_integ8`: 231 tables, 277,812 rows, 192 MB on disk, 14 MB compressed |
| Restore into a fresh database | 20 s | same dump, 2 triggers, 21 migrations |
| Release step on a dump five migrations old | 6 s | `prisma migrate deploy`, `20261003090000` to `20261004120000` |
| Full drill (dump, restore, status, diff, counts, triggers) | 49 s | `scripts/db/restore-drill.sh` |
| Documents: tar + checksum, untar + verify | 1.7 s + 0.1 s | the local storage root: 78 files, every checksum identical |
| Point in time: markers, archive of every closed log, dump restored and rolled forward to the target second | 110 s for the whole drill; restore 15 s, replay under 1 s | `restore-drill.sh --pitr require`: 29 logs (about 560 MB) archived, the write before the target time kept, the write after it excluded, 231 tables equal |
| Documents drill: archive, restore into a fresh directory, every file compared | under 1 s | `scripts/storage/restore-drill.sh`: 81 files (storage root and product images), every SHA-256 identical, one file compared byte for byte |
| Off-site drill: fresh backup set shipped encrypted, fetched on a clean workspace, restored | 17 s | `scripts/backup/offsite-drill.sh` to a local remote: 84 files / 531 MB, nothing readable in the bucket, 39 sidecars verified, documents and database restored |
| Failure drill (row 9.18): the database restored from the off-site copy to the second before a chosen sale, with an API serving it | 26.5 s from the decision to the restored API answering sign-in (restore 15 s, replay 0 s, API start 6 s); 40 s from the chosen sale, with the archive flush and the push | `docs/DRILLS.md` §3.6 on the production-shaped stack: 232 tables, 22 migrations, the chosen sale and the two after it absent, the three before it present, the restored day reconciled CLEAN |
| Reconciliation of one shop's business day (seven checks) | 20 to 100 ms per shop-day in the engine; the nightly sweep of the local test database, over 2,000 shops, under a minute; `npm run reconcile` about 15 s including ts-node start-up | `ReconciliationRun.startedAt` to `finishedAt`; the day of the integration spec (six sales, two returns, a cancellation, two repayments, one shift) in under 100 ms |

A first drill against the same database refused at the status step because
the source was five migrations behind the repository; after `migrate deploy`
it passed. That is the older-release case of the runbook and the reason the
drill checks it.

The restore itself is a small part of the hour. Budget for the database
objective:

| Phase | Budget | What bounds it today |
|---|---|---|
| Detect | 10 min | `DukaanAiDependencyDown` ("The API cannot reach database") fires after 2 minutes, readiness answers 503 and every request 503 `DATABASE_UNAVAILABLE` while the database is down (the MySQL drill of row 9.18); `DukaanAiBackupStale` / `DukaanAiBackupNeverRecorded` say when a backup is missing (row 9.4). |
| Decide and reach the host | 10 min | one operator today; the rota is row 9.22 |
| Restore | 15 min | measured above; the dump restores at roughly 0.7 MB/s of compressed dump, and one shop's year of billing is a few megabytes |
| Verify | 10 min | `restore-drill.sh` steps 3 to 6 and 10 (the restored copy's books reconcile), sign-in, a test sale |
| Switch and warm | 5 min | `DATABASE_URL`, start, caches rebuild |
| Reserve | 10 min | |

Documents (4 hours): detect, fetch the archive from the off-site copy (up to
1 hour at consumer bandwidth), untar and verify checksums, remount, with the
rest in reserve. The failure drills of row 9.18 rehearsed the database
budget's restore step on the production-shaped stack (26.5 s from the
decision to a serving API, `docs/DRILLS.md` §3.6) and the detection
(readiness answered 503 within the second in the MySQL drill;
`DukaanAiDependencyDown` paged after 2 minutes in the Redis drill, and holds
the same 2 minutes for the database); the staging runs (§6 there) replace
these figures with the managed provider's.

## 5. Gaps against the objectives and what closes them

| Gap | Today | Objective | Closed by |
|---|---|---|---|
| Database recovery point | self-hosted: the archive interval, 5 minutes, with the `binlog-archiver` service or the cron line running (in place since this revision); managed: the provider's point-in-time recovery, to switch on when the instance exists | 5 minutes | 9.2: done for the self-hosted path; the provider settings and the provider drill wait for the account |
| Copies on the database host only, unencrypted | `db-ops offsite push` ships the whole volume nightly through rclone's crypt backend to `OFFSITE_REMOTE`, verified by cryptcheck, drilled in CI against a local remote and in the compose smoke; the real bucket in another account waits for the account | off-site, encrypted, in another account | 9.4: done; set `OFFSITE_REMOTE` and the key when the bucket exists |
| Nobody is told when a backup is missing or old | every job stamps `BACKUP_STATUS_DIR`, the API exposes `backup_last_success_timestamp_seconds{kind}`, `DukaanAiBackupStale` (binlog 15 min, nightly jobs 26 h) and `DukaanAiBackupNeverRecorded` fire; `promtool test rules` proves it in CI | the same | 9.4: done |
| Documents and product images | `db-ops documents-backup` nightly with a per-file manifest, `restore.sh` verifies every file, the drill runs in CI | scheduled, checksummed, restore-drilled, incl. `uploads/media` | 9.3: done |
| A restored day's books are not proven to agree | `ReconciliationService` proves every shop's previous business day nightly (documents, postings, tenders, dashboard, shifts, stock, account balances, to the paisa; `GET /reconciliation/latest`, `POST /reconciliation/run`, `npm run reconcile`), drift raises `DukaanAiReconciliationDrift`, and the restore drill runs the same reconciliation on the restored copy (step 10) | reconciliation of invoices, ledger, tenders, stock and dashboard to the paisa | 9.5: done |
| One operator, no rota, no rehearsed incident flow | the repository owner; the six failure drills run against a production-shaped stack and on every release candidate (`docs/DRILLS.md`) | on-call rota, runbook per alert, drills on staging | 9.18 (staging runs), 9.22 |
| Secrets never rotated | register and procedures written (`docs/SECRETS.md`), the JWT rotation mechanics proven in CI (`credential-rotation.integration-spec.ts`), gitleaks on every push; the staging rotations wait for staging | every secret rotated once on staging and logged in the register | 9.11 |

### The schedule that meets the objectives

The four jobs, from the host's cron or the `binlog-archiver` service
(`docs/BACKUP_RESTORE.md`, "Backup"):

```
0 2 * * *    cd /srv/dukaanai && docker compose --profile ops run --rm db-ops backup                  # dump
*/5 * * * *  cd /srv/dukaanai && docker compose --profile ops run --rm db-ops binlog-archive --flush  # binary logs
10 2 * * *   cd /srv/dukaanai && docker compose --profile ops run --rm db-ops documents-backup        # evidence + images
30 2 * * *   cd /srv/dukaanai && docker compose --profile ops run --rm db-ops offsite push            # encrypted copy elsewhere
```

Where the archive cannot run (a backup user without REPLICATION SLAVE and
RELOAD), dump hourly into its own directory instead
(`--out /backups/hourly --keep 48`; pruning is per directory and per
database name): one hour instead of twenty-four. Once a quarter, and
before every go-live, restore the newest off-site copy on a scratch
machine with the procedure in `docs/BACKUP_RESTORE.md` ("Restoring on a
clean machine"): CI's drills prove the scripts on CI's data, not your
backup files. Before every `migrate deploy`: the labelled pre-release
backup (`DEPLOYMENT_CHECKLIST.md`, phase 2).

## 6. Decisions

- Production runs on a managed MySQL 8 service with high availability,
  automated backups and point-in-time recovery, deletion protection and a
  private endpoint (the roadmap discussion of 2026-10-04); the self-hosted
  binary-log path of row 9.2 is the fallback only.
- Documents stay files under `STORAGE_ROOT` on a persistent cloud disk
  with provider snapshots, served by a single API replica (row 9.7,
  decided 2026-10-05 and built: `docker-compose.prod.yml`, `deploy/k8s/`,
  `docs/DEPLOYMENT.md` "Production topology"); `replicas > 1` is never set
  until the documents move to object storage behind `StoragePathBuilder`.
  The `backup-agent` (compose service / Kubernetes sidecar) runs the daily
  dump, documents archive and off-site copy in that topology; the
  binary-log archiver stays the self-hosted fallback.
- `uploads/media` is customer data (product images) and joins the documents
  objective; `uploads/imports`, `exports` and `tmp` are reproducible and are
  not backed up.
- The in-app zip (`POST /storage/backup`) is a per-shop export for row 9.24,
  not part of the recovery design.
- Redis is disposable. No backup is taken and none is restored.
- Point-in-time recovery is the provider's on a managed MySQL and the
  binary-log archive on a VM; a dump always records its position so either
  path can start from it.
- Off-site copies go through rclone's crypt backend to a bucket in another
  region and account, with the key in the secret store and nowhere near
  the data; the local remote is only for drills. The documents archive
  carries a per-file manifest so a restore is verified file by file.

## 7. Sign-off

Row 9.1 is complete: the owner has signed the objectives in section 1 and
the decisions in section 6.

| Role | Name | Date | Signed |
|---|---|---|---|
| Owner | shoryabansalgithub | 2026-10-05 | signed (confirmed in the working session of 2026-10-05) |

Review this document: at every change to a data store, a backup script or a
schedule; when rows 9.2, 9.3, 9.4, 9.5, 9.11 and 9.22 close (replace the
"today" column of section 5 and the measured times of section 4 with the
staging figures); and before the go/no-go record (`docs/GO_LIVE.md`).
