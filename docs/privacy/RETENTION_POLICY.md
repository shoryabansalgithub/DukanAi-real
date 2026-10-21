# Retention policy

Roadmap 9.24. How long DukaanAI keeps each kind of data, and what deletes
it. The values in §1 are the defaults of the nightly retention sweep
(`RetentionSweepService`, `apps/api/src/config/domains/retention.config.ts`,
roadmap 7.8). `personal-data.spec.ts` fails when this table and the
defaults disagree, so a change to either must update the other.

## 1. Deleted by the nightly sweep

The sweep runs on `CRON_RETENTION_SWEEP` (default 03:30 every night).

| Data | Kept for | Variable | Default |
|---|---|---|---|
| Refresh tokens (sessions) | days after the token expired | `RETENTION_EXPIRED_TOKENS_DAYS` | 7 |
| Password-reset tokens | days after use or expiry | `RETENTION_EXPIRED_TOKENS_DAYS` | 7 |
| Delivered outbox events | days after creation (failed rows stay until an operator retries them) | `RETENTION_OUTBOX_DONE_DAYS` | 14 |
| Search history (what staff typed into search boxes) | days | `RETENTION_SEARCH_HISTORY_DAYS` | 90 |
| Product event log | days | `RETENTION_PRODUCT_EVENT_LOG_DAYS` | 180 |
| Webhook delivery attempts (each with the event payload sent) | days after the attempt | `RETENTION_WEBHOOK_DELIVERY_DAYS` | 30 |

## 2. Kept while the shop is a customer

The shop's business records are kept for as long as the shop uses
DukanAI: products, customers, invoices, returns, credit, shifts, stock,
purchasing, expenses, the audit log, notifications and documents. The
shop deletes individual customers, suppliers and products from the app (a
soft delete). Erasing a customer's personal data is a request to support
(`DATA_REQUESTS.md`).

Tax records are a special case. GST requires invoices and accounts to be
kept until 31 December of the financial year's start year + 7 (CGST Act
s.36; see `DATA_INVENTORY.md` §3). That duty is the shop's. DukaanAI meets
it while the shop is a customer, and hands the shop its full export before
erasing a shop.

## 3. After a shop leaves

| Step | When |
|---|---|
| The shop is suspended (no sign-in, nothing changes) | on the request, after the identity check |
| The export is delivered | within 7 days of the request |
| The shop's personal data is erased (`shop-data erase`) | 30 days after suspension, unless the shop withdraws the request |
| The erased data leaves the backups | as the backups age out: hourly dumps after 2 days, nightly dumps and document archives after 14 days, off-site copies after 30 days, binary logs after 7 days |

After the erasure, the remaining rows are anonymised financial history
(amounts, dates, document numbers, product names). They cannot be linked
to a person. They are kept because the ledger is immutable by design.

## 4. Operational stores

| Store | Kept for | Where it is set |
|---|---|---|
| Logs (Loki) | 31 days | `deploy/loki/loki.yml` |
| Metrics | Prometheus default (15 days) | `deploy/observability/compose.yml` |
| Database dumps | 14 nightly, 48 hourly | `scripts/db/backup.sh --keep` |
| Binary-log archive | 7 days | `BINLOG_ARCHIVE_KEEP_DAYS` |
| Documents archives | 14 | `scripts/storage/backup.sh` |
| Off-site copies | 30 days | `OFFSITE_KEEP_DAYS` |
| Redis cache and rate-limit counters | seconds to an hour | expire on their own |
| Error tracking | the Sentry project's setting: 30 days or less | the Sentry project |

## 5. Open items for the advisor

| # | Item |
|---|---|
| P-1 | The DPDP Rules, 2025 ask fiduciaries to keep processing logs for at least one year. Logs are kept 31 days. Either raise `retention_period` (disk: about 1 GB per shop-year at the pilot's volume) or record why the shorter period suffices for the logs DukaanAI keeps as a fiduciary. |
| P-2 | Confirm 30 days as the notice period between suspension and erasure, and 7 days for delivering the export. |
| P-3 | Confirm that keeping anonymised financial rows after an erasure is acceptable. |
| P-4 | Login attempts are not swept. Decide on a window (90 days is the usual choice) or record why it is not needed. |
