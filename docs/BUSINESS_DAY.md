# Simulated business day (roadmap 9.17)

A whole trading day, played against a running deployment at 5.3x speed with
every kind of document the POS produces, two failures injected while it
runs, and a gate that reads the outcome back over HTTP: nothing lost,
nothing duplicated, nothing partial, the books clean. The plan is
`apps/api/load/business-day.yml`, the driver `apps/api/load/business-day.mjs`,
the browser half `apps/web/e2e-load/business-day.spec.ts`; `apps/api/load/README.md`
has the commands. This document records what the day consists of, how the
gate is computed, and the runs.

## 1. The day

| Element | Plan |
|---|---|
| Shops | 10, each registered through the public routes with an owner; a manager, 3 counter cashiers and (where browser sessions run) a UI cashier seeded through `BUSINESS_DAY_DATABASE_URL` |
| Catalogue per shop | 8 everyday products across the GST slabs (ZERO, FIVE, TWELVE, EIGHTEEN, TWENTYEIGHT) with 5,000 units each, plus one scarce product (25 units) so `INSUFFICIENT_STOCK` is exercised; a supplier; a warehouse; 6 credit customers (limit 50,000) and 4 plain ones |
| Shop time | 8 hours compressed into 90 real minutes (`BUSINESS_DAY_MINUTES`) |
| Cashier profile | sales per cashier per shop hour `[6, 10, 14, 18, 16, 10, 14, 16]`: slow opening, lunch peak, afternoon lull, evening peak; 104 sales per cashier, about 3,100 for the fleet |
| Sales | 1 to 4 lines of 1 to 3 units; 55 % cash (with change), 30 % UPI (with a reference), 15 % credit on a customer with a limit; 30 % carry a 5 or 10 % line discount or a 5 % invoice discount (inside the cashier's authority); the manager bills 4 per 100 with a 15 % discount (above it) |
| Returns | 6 per 100 sales: one unit of one line of the cashier's own recent sale, refunded by the sale's tender (the credit portion first, as the contract says) |
| Cancellations | 3 per 100 sales, by the manager, a sale of the day with no returns |
| Repayments | 5 per 100 sales: a credit customer pays part of the outstanding balance, cash or UPI |
| Stock receipts | 2 per shop (at 15 % and 55 % of the day): purchase order -> submit -> approval by the manager (separation of duties) -> goods receipt against the order -> receive -> inspect PASS -> accept, which stocks the goods and posts the payable |
| Shifts | every counter cashier and the manager open a drawer at opening time and close it at closing time; one cashier per shop closes and reopens at half-time |
| Dashboard | the owner polls the four dashboard reads every 30 s and the notifications every 60 s, and reads the invoice and customer lists every 10 min |
| Browser sessions | per shop two Chromium contexts with real sign-in: an owner on the dashboard who walks the lists, cancels a recent sale from the invoice page and records a repayment on a customer page; a cashier who opens the drawer from the banner, bills cash, UPI and credit sales from the POS (a line discount now and then), returns one unit every fifth sale from the invoice page and closes the drawer at closing time |
| Failures | Redis restarted at 35 % of the day; one API instance killed (SIGKILL) at 60 % with a checkout burst in flight, started again 90 s later |

Every document request carries an idempotency key and is retried with the
same body on a network failure, an edge error or a 429, as the POS web does
with its Retry button; a document whose answer never arrived in the retry
budget is replayed once more at closing time, which is what a cashier does.
Nothing is told that an instance died: the sessions pinned to it find out
from a dropped socket and from the 3-second health probe, as a load
balancer's health check would, and move to the other instance.

## 2. The gate

Read back over HTTP by the driver after the day, no database access:

| Check | How |
|---|---|
| Zero 5xx answered by the API | every attempt is logged; a 5xx carrying the API's JSON error body (or its `x-correlation-id`) counts, a bare 502/503/504 from an edge while the instance is dead is an edge error, reported separately |
| Every idempotency key resolved to exactly one invoice | per shop, `GET /billing/invoices?type=SALE` (every page) must equal the set of invoice ids the API sessions and the browser sessions confirmed: an id the API lists that no session confirmed is a duplicate (or a phantom), a confirmed id the API does not list is lost; the same for `SALES_RETURN` |
| Cancellations and repayments accounted for | the set of `CANCELLED` sales equals the cancellations the sessions confirmed; per credit customer, the `PAYMENT` rows of `GET /customers/:id/ledger` equal the repayments confirmed |
| In-flight documents of the killed instance complete or absent, never partial | the keyed requests pending at the instant of the kill are followed to their outcome: `complete-after-retry` (the retry was answered 200 with the existing invoice: the dead instance had committed) or `absent-then-created` (the retry was answered 201: it had not); a partial document would break the reconciliation identities below |
| Reconciliation CLEAN | `POST /reconciliation/run` for every shop and every IST business date the day touched (a run can cross midnight): status CLEAN, drift 0 (documents, postings, tenders, dashboard, shifts, stock, ledger: contract §11) |
| Both failures injected | the Redis restart and the kill/start hooks ran and the instance answered again |
| Browser sessions | ran the whole day with no fatal session error and saw no 5xx |

The report is `load/reports/business-day-<stamp>.json` (every record) with a
`.md` summary and an `.attempts.jsonl` log of every request (actor, action,
key, target, status, duration). Refusals the API answers with a 4xx
(`INSUFFICIENT_STOCK`, `CREDIT_LIMIT_EXCEEDED`, `RETURN_QTY_EXCEEDS`,
`INVOICE_NOT_CANCELLABLE`) are counted by code and are not failures: they
are the system saying no, which is the point.

## 3. Runs

### On this machine (two API instances)

`apps/api/load/business-day.sh`: a dedicated Redis on 6391, two `node
dist/main` instances on 3041 and 3042 against one disposable MariaDB
database, the web on 3043 with real authentication, the driver with its
hooks wired to this stack (`kill -9` of instance 2, the script's
`--start-instance 2` and `--restart-redis` re-entries). Recorded below from
the report of each run.

| Run | Date (UTC) | Scale | Outcome |
|---|---|---|---|
| 1, interrupted | 2026-10-06 20:11 to 21:42 | 10 shops x 3 cashiers, browser sessions on 5 shops, 90 min | **Not a gate run**: at 21:34, 92 % through the day, the database process was stopped by the tool harness that had started it (its two-hour background limit), not by the plan; it was restarted at 21:42. Before that: 2,887 sales (1,603 cash, 874 UPI, 410 credit; 977 with a discount; 104 billed by the manager at 15 %), 177 returns, 89 cancellations, 127 repayments, 20 stock receipts (every order approved, every receipt accepted), 10 mid-day drawer changes, 1,674 dashboard polls, 17,687 requests, 0 API 5xx and 7 dropped sockets until the outage. Redis restarted at 20:43 (the API's throttler logged the outage and the recovery; nobody noticed). Instance 2 killed at 21:05:30 with 6 checkouts in flight: all 6 were `absent-then-created` (the dying instance had not committed; the retry created each once on the other instance), the probe saw it down, it answered again at 21:07:02. During the 7 min 22 s without a database the API answered 2,434 requests with its own 500 (`INTERNAL_SERVER_ERROR`, the JSON body of the global filter) and no document was created; once the database was back, every shop verified: 2,887 sales and 177 returns on the API exactly equal to the confirmed sets, 89 CANCELLED, every ledger PAYMENT row accounted for, reconciliation CLEAN for all 10 shops. The browser sessions produced nothing: see §4 (two harness defects and one real web defect found by this run). Report: `business-day-20261006T201059Z.{json,md}` (kept outside the repository). |
| 2 | 2026-10-06 21:54 to 23:24 | 10 shops x 3 cashiers, browser sessions on 5 shops, 90 min, both failures | **PASS on every gate.** 3,200 sales (1,760 cash, 994 UPI, 446 credit; 1,024 with a discount; 115 billed by the manager at 15 %; 3 refused `INSUFFICIENT_STOCK` when the scarce product ran out), 183 returns, 94 cancellations, 143 repayments, 20 stock receipts, 10 mid-day drawer changes, 1,800 dashboard polls; 16,467 requests, 0 API 5xx, 0 edge errors, 0 x 429, 6 dropped sockets (the kill). Redis restarted at 22:25:30 (no visible effect). Instance 2 killed at 22:48:00 with the 6-checkout burst in flight: the health probe reported it down within the second, every one of the 6 was `absent-then-created` on the second attempt (the dying instance had not committed; one invoice each, created once on the other instance), the instance was started at 22:49:30 and answered again at 22:49:32. Every shop verified: the API's sale and return lists equal to the confirmed sets, every CANCELLED invoice and every ledger PAYMENT row accounted for, reconciliation CLEAN for all 10 shops on 2026-10-07 (IST). Browser sessions: 5 owners and 5 cashiers for the whole day with no lost session, 312 UI sales, 29 returns, 48 cancellations, 48 repayments, every drawer opened from the banner and closed at closing time, 0 x 5xx seen by the pages; 31 non-fatal step errors, all the same (§4, harness). Report: `business-day-20261006T215331Z.{json,md}`. | |

### Shortened day on every certification (roadmap 9.12)

`scripts/certify/certify.sh` step `business-day`: `CERTIFY_BUSINESS_DAY_MINUTES`
(6) minutes over three shops with the browser sessions on one of them,
compose as the hook runner (`restart redis`, `kill api`, `start api`). The
stack has one API container, so the kill takes the only instance down and
every session waits the outage out with the same key
(`BUSINESS_DAY_RETRY_SECONDS`, 150 s by default). The result is the
`business-day` row of the bundle's `SUMMARY.md`.

### On staging (the owner's run)

The deliverable of the roadmap row. Staging runs the production images and
limits (`docs/STAGING.md`), so the day is driven from a machine that reaches
the stack's database (the seed of the staff) and the hosts:

```bash
cd apps/api
BUSINESS_DAY_TARGETS=https://<API_HOST> BUSINESS_DAY_WEB_URL=https://<WEB_HOST> \
BUSINESS_DAY_DATABASE_URL='mysql://...staging...' \
BUSINESS_DAY_CHAOS_REDIS_RESTART='ssh staging "docker compose -f docker-compose.prod.yml restart redis"' \
BUSINESS_DAY_CHAOS_API_KILL='ssh staging "docker compose -f docker-compose.prod.yml kill api"' \
BUSINESS_DAY_CHAOS_API_START='ssh staging "docker compose -f docker-compose.prod.yml start api"' \
node load/business-day.mjs
# in parallel, the browser sessions:
cd ../web && BUSINESS_DAY_STATE_FILE=../api/load/.business-day.state.json BUSINESS_DAY_WEB_URL=https://<WEB_HOST> npm run test:business-day
```

Two things the operator decides before the run:

- Addresses. Through the edge every request comes from the generator's
  address, and the production limits (`docs/PRODUCTION_LIMITS.md`) are
  sized per shop: either allow the generator's address in the edge's
  `trusted_proxies` for the run and set `BUSINESS_DAY_FORWARD_FOR=1` (one
  address per shop, as in production), or keep the limits and drive fewer
  shops.
- Redis. The managed Redis of the production topology has no `restart`
  hook; the provider's failover or a `redis-cli DEBUG RESTART` on a
  self-hosted one plays the same part. With one API replica the kill is
  the container restart the certify step already exercises.

Record the report with the release note and the row in `docs/STAGING.md`.

| Run | Date | Images | Result | Report |
|---|---|---|---|---|
| staging | pending the staging owner | | | |

## 4. What the day found

Run 1 found three things, two in the harness and one in the product:

1. **The web signed every owner out after exactly one access-token lifetime**
   (15 minutes), in every shop. The API log says why: `Refresh token reuse
   detected for user ... revoking all sessions`, four times per owner, 70 to
   150 ms apart, at the 15-minute mark of the browser sign-in. NextAuth's
   `jwt` callback exchanged the refresh token once and shared that exchange
   only while it was in flight; the dashboard's parallel reads then arrived
   with the browser's old cookie a moment after the first exchange had
   finished, presented the consumed token, and the API, correctly, treated
   the second presentation as theft and ended every session of the account,
   the driver's API session of the same owner included (its next refresh
   answered 401 and it signed in again). Fixed in `apps/web/src/lib/auth.ts`
   with `src/lib/refresh-handoff.ts`: the successor of a rotated token is
   kept for two minutes, keyed by the token it consumed, and every late
   caller receives it instead of a second exchange; a failed exchange is not
   kept. `apps/web/e2e/refresh-handoff.spec.ts` proves the hand-off. A real
   user with the dashboard open would have met this after a quarter of an
   hour; no earlier suite runs that long.
2. **Harness: the browser cashier never opened its drawer.** The "No open
   shift" banner nests a longer sentence, so an exact-text locator never
   matched; the sessions now match the substring and wait for the banner
   to settle before deciding (and wait for an invoice page's heading before
   looking for its Return and Cancel buttons).
3. **Harness: an orphaned `next dev` from an earlier rehearsal still held the
   web port**, so the run's own web server died with `EADDRINUSE` and the
   browser sessions used the stale one. `load/business-day.sh` now frees its
   ports before it starts and finishes the whole `next dev` process tree
   when it stops.

Run 2 left one harness note: in 31 of the browser cashiers' 60 return
attempts the return dialog's submit was still disabled after 20 s (the
engine preview had not settled, with ten browser sessions sharing one
`next dev` server on four cores); the 29 that went through and the 183
returns of the API sessions were all accepted. The step now waits for an
enabled quantity field and for the preview, and records the dialog's
buttons and alert when it gives up, so the next run says why.

Two observations worth keeping:

- A SIGKILL of an instance with checkouts in flight produced no partial
  document and no duplicate: the six in-flight sales were absent (the
  transaction had not committed when the process died) and the retry
  created each once on the surviving instance. The health probe saw the
  instance down within a second; sessions pinned to it moved over on their
  next attempt.
- A database outage behaves as designed: the API answers its own 500 on
  every request that needs the database (a probe would have turned
  readiness to 503), creates nothing, and the moment the database is back
  the retried keys resolve and the books reconcile. The outage was not
  planned here; row 9.18 drills it deliberately (stop MySQL for 60 s).
