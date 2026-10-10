# On-call and incident runbooks (roadmap 9.22)

What to do when DukaanAI pages you. Section 1 says who does what in an
incident, section 2 how bad it is, section 3 what to tell the shops, section
4 the commands every runbook uses, section 5 has **one runbook per alert in
`deploy/prometheus/alerts.yml`** (each alert's `runbook_url` points at its
page here, and `apps/api/src/common/observability/runbooks.spec.ts` fails
when an alert has no page or a page has no alert), section 6 the review
after an incident, and section 7 the record of every runbook walked.

The alert table in `docs/OBSERVABILITY.md` is the one-line summary; the
pages here are what you follow. Related: `docs/DRILLS.md` (what each failure
looked like when it was rehearsed), `docs/BACKUP_RESTORE.md` (restores),
`RELEASE.md` (deploy and roll back), `docs/SECRETS.md` (rotations),
`docs/DATA_SAFETY.md` (recovery objectives).

## 1. Incident roles

| Role | Who by default | Does |
|---|---|---|
| **Incident lead** | the on-call primary who acknowledged the page, until they hand over | Declares the incident and its severity, decides, assigns the other roles, keeps the timeline, says when it is over. Does not type commands in a SEV1 if anyone else can. |
| **Operator** | the on-call primary (the lead's hands in a one-person rota) | Runs the runbook, says what they see before they change anything, writes every command into the incident channel. |
| **Communicator** | the on-call backup, from 15 minutes into a SEV1 | Sends the shop messages of section 3 on time, answers the shops' phones and WhatsApp, collects what shops report (which shop, which screen, which time) for the lead. |
| **Owner** | the product owner (`docs/SECRETS.md` lists the people) | Approves what cannot be undone or that the shops will notice: restoring a backup, rolling back a release with a destructive migration, a data correction in a shop's books, telling shops that data was lost, a security notice. |

In a one-person rota the primary is lead and operator, and calls the backup
for communications when a SEV1 passes 15 minutes. The incident channel is
the team's chat channel where the alerts land; one thread per incident,
named `INC <date> <alert>`.

**Lifecycle.** Page → acknowledge (critical: within 15 minutes, day and
night) → assess (section 2) → declare (thread, lead, severity) → mitigate
(the runbook) → tell the shops (section 3) → resolved (the alert has
cleared AND the runbook's verification passed) → review (section 6, within
five working days for SEV1 and SEV2).

**Rules that hold in every incident.**

- Sales are the priority: anything that keeps the POS billing correctly
  comes before diagnosis.
- Never edit a shop's books by hand in the database. Corrections go through
  the application (a stock adjustment, a repayment, a cancellation) so the
  ledger and the reconciliation see them; the ledger tables refuse updates
  anyway (immutability triggers).
- Never restore a backup over the live database. Restores go to a new
  database and are switched to (`docs/BACKUP_RESTORE.md`), with the owner's
  approval.
- Write down what you did and when, in the thread, as you do it.

## 2. Severity

| Severity | When | Examples (default severity of each alert in section 5) | Shop messages |
|---|---|---|---|
| **SEV1** | Shops cannot bill, or money or data is at risk | API down, database down, 5xx wave, expired certificate, ledger posting failures, reconciliation drift that moves money | first within 15 min, then every 30 min, and when it ends |
| **SEV2** | Billing works but something shops use does not, or a SEV1 is close | storage full (photos refused), email failing, a backup late, Redis down (jobs wait), certificate expiring within 3 days, a stuck queue that delays something shops wait for | when shops notice or ask, and when it ends |
| **SEV3** | No one is affected yet | a warning that can wait for the morning: storage low, a backup never recorded on a new stack, a queue with old failed jobs | none |

Raise the severity when shops report what the alert did not predict, or
when a SEV2 has lasted an hour. Lower it only when the runbook's
verification has passed.

## 3. Messages to shop owners

Shop owners hear from us by the channel they gave at onboarding (WhatsApp
broadcast list, SMS or email; the list is kept with the shop contacts, not
in this repository). Plain words, no internal names, always what still
works and what they should do. Fill the braces; times in IST.

**S1: investigating, billing affected**

> DukaanAI: since {time} some shops cannot complete bills; the screen asks
> to retry. We are working on it. Please keep the customer's items aside
> and press **Retry** on the bill when it asks: a retried bill is never
> charged twice. Do not enter the same sale again as a new bill. Next
> update by {time}.

**S2: investigating, billing works**

> DukaanAI: since {time} {what does not work: "saving bill photos" / "the
> dashboard figures" / "emails such as password resets"} is not working.
> Billing works normally. We are fixing it and will tell you when it is
> back. Next update by {time}.

**S3: update, with a workaround**

> DukaanAI update {time}: {what changed}. Until it is fixed: {workaround:
> "write the bill on paper with the time and the amount, and enter it in
> DukaanAI once the screen works" / "take the photo again later; nothing
> was saved"}. Next update by {time}.

**S4: resolved**

> DukaanAI: fixed at {time}. {What happened, in one sentence.} Bills made
> before and after are safe{; bills that showed an error were completed
> when you pressed Retry}. If anything looks wrong on your screen, reply to
> this message with your shop name.

**S5: planned maintenance** (a release with downtime, `RELEASE.md`)

> DukaanAI: on {date} between {time} and {time} we are updating DukaanAI.
> Billing may stop for up to {minutes} minutes in that window. Please
> finish open bills before {time}; nothing else is needed.

**S6: a correction to a shop's books** (after `DukaanAiReconciliationDrift`, owner approved)

> DukaanAI: our nightly check of your books for {date} found {what, in
> words: "one bill whose stock was not reduced"}. We corrected it on {date}
> with {"a stock adjustment" / "an entry"} that you can see under {screen}.
> Your sales and cash totals {are / are not} affected. Call us on {number}
> if you have questions.

**S7: sign in again** (after a secret rotation or a security incident, `docs/SECRETS.md`)

> DukaanAI: for your security everyone has been signed out at {time}.
> Please sign in again with your email and password. {If needed: "If you
> cannot, use 'Forgot password' on the sign-in page."} No data was {lost /
> seen by anyone else}.

Send S1 only for SEV1, S2 for SEV2 when shops will notice. One message per
step: never more than one update every 30 minutes unless something
changed.

## 4. Commands every runbook uses

Production runs `docker-compose.prod.yml` on one host (`/srv/dukaanai`,
`docs/DEPLOYMENT.md`); Kubernetes equivalents are in the second line. Set
once in your shell:

```
cd /srv/dukaanai && alias dc='docker compose -f docker-compose.prod.yml'
# Kubernetes: alias k='kubectl -n dukaanai'
```

A check never starts anything: every `dc run` below carries `--no-deps`.
Without it compose starts the service's dependencies first, and on a stack
that runs its own database (the reference compose, the drill stack) that
ends the very outage being diagnosed (found walking
**DukaanAiDependencyDown**).

| What | Command |
|---|---|
| State of the services | `dc ps` · `k get pods` |
| Readiness and the failing dependency | `curl -sS https://<API_HOST>/api/health/ready` (503 `{status, checks}` names it) |
| API logs, errors only, last 15 min | `dc logs --since 15m api \| grep -E '"level":"(error\|fatal)"'` · `k logs deploy/dukaanai-api --since=15m` |
| One request's log lines | Grafana › Explore › Loki: `{service="api"} \| json \| message_correlationId="<id>"` (the id is in every error answer and in the error tracker's tags) |
| Answers of one route | `{service="api"} \| json \| message_event="http" \| message_route="/api/billing/invoice"` |
| A metric | Prometheus (operator tunnel, `docs/OBSERVABILITY.md`) or the Grafana operations dashboard |
| Firing alerts and what holds them back | `curl -s http://localhost:9093/api/v2/alerts \| jq '.[] \| {alert: .labels.alertname, state: .status.state, inhibitedBy: .status.inhibitedBy}'` |
| Restart the API (graceful: drains in-flight requests) | `dc restart api` · `k rollout restart deploy/dukaanai-api` |
| Backups' last success | `dc --profile ops run --rm --no-deps db-ops status` |
| A SQL prompt as the database administrator (lock waits, `KILL`) | managed database: the provider's query console, or `mysql` with the admin user over TLS from the operator host (the backup user of `db-ops` lacks `PROCESS` and `CONNECTION_ADMIN`); a stack with its own MySQL (reference compose, drill stack): `dc exec mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot dukaanai'` |
| Reconcile a shop's day | as the shop's owner `POST /api/reconciliation/run {"date":"YYYY-MM-DD"}`; as the operator, in the API container (the image carries the command and the database address): `dc exec api node dist/cli/reconcile --shop <shopId> --date <day>` (exit 0 clean, 1 drift), `--all-shops` for what a missed night would have run · `k exec deploy/dukaanai-api -- node dist/cli/reconcile ...`; from a checkout, `npm run reconcile -- ...` is the same command |
| End sessions (a leaked secret, a stolen account) | `dc exec api node dist/cli/revoke-all-sessions --user <id\|email> --yes`; every account without `--user`; without `--yes` it only counts (`docs/SECRETS.md`) |
| API log lines older than the running container | Loki: `{service="api"} \|= "<text>"` over the window; `dc logs` starts where the container did, and every deploy recreates it (`dc ps` says when) |
| Deploy, roll back | `RELEASE.md` |

## 5. Runbooks

Each page: what the alert means and who is affected, the first checks in
order, the fix for each cause found, how to verify it is over, what to tell
the shops. The **Walked** line records the last rehearsal (section 7 has
the details).

Alerts read from a gauge the API exports (storage, outbox, backups,
reconciliation, queues) keep firing two minutes after their condition
clears (`keep_firing_for`), so a restart of the API, which every deploy is,
cannot resolve them with the cause still there; give **Verify** those two
minutes. A restart does start the hold time (`for:`) of an alert that is
only pending again.

### DukaanAiApiDown

**Critical · SEV1 if users see it.** Prometheus could not scrape
`/api/metrics` on an API instance for 2 minutes. Either the API process is
down, restarting in a loop or hung, or only the scrape path is broken. If
the API is really down every screen fails: the POS offers Retry (the edge
answers 502), the dashboard keeps its last figures. While this fires every
warning and the probes' **DukaanAiEndpointDown** are held back (they appear
after it clears if their cause remains).

**First checks**

1. From your own machine: `curl -sS -o /dev/null -w '%{http_code}\n' https://<API_HOST>/api/health`.
   200 means the API is alive and only the scrape fails: go to "Scrape path" below (SEV3).
2. `dc ps api`: running, restarting, exited? How many restarts?
3. `dc logs --since 10m api | tail -100`: a `[Bootstrap FATAL]` line names a
   refused setting; `Killed` / exit 137 is memory; nothing new means hung.
4. The host: `df -h /`, `free -m`, `docker stats --no-stream`.

**Fix**

- *Stopped* (`Exited (0)`, no restarts, `Shutdown requested by SIGTERM`
  the last log line): something stopped it and nothing started it again (a
  deploy interrupted between `stop` and `up`, a `dc stop`, the host's
  maintenance). `dc up -d api`, then find out who stopped it.
- *Boot refused* (`[Bootstrap FATAL] ...`): the message names the setting
  (`JWT_SECRET`, `FRONTEND_URL`, `STORAGE_ROOT`, `LOG_LEVEL`...). Correct
  `.env`, `dc up -d api`. If it began with a deploy, roll back to the
  previous tag (`RELEASE.md`, "Rollback") and fix the setting before
  promoting again.
- *Killed for memory*: `dc up -d api`; find what grew (an import of a very
  large file, an export) in the last log lines before the kill; raise the
  container's memory limit if the load was legitimate.
- *Hung* (health times out, process present): `dc restart api`. Shutdown
  drains in-flight requests (`SHUTDOWN_TIMEOUT_MS`), so sales in progress
  finish or are retried by the POS.
- *Host down*: the provider's console; once the host is up `dc up -d`
  (the restart policy starts everything); the database is managed and was
  not on this host.
- *Scrape path* (API alive): `dc ps prometheus`, Prometheus › Status ›
  Targets for the scrape error. A `401` means `METRICS_TOKEN` differs
  between the API and `deploy/prometheus`'s bearer file; a timeout with
  `dependency_up` missing means a source hangs (finding 4 of
  `docs/DRILLS.md`).

**Verify.** `/api/health/ready` is 200, the alert resolved, and
`scripts/smoke-remote.sh https://<WEB_HOST> https://<API_HOST> --probes-only`
passes. Then the warnings that were held back: read each.

**Tell the shops.** S1 if billing failed for more than 5 minutes; S4 when
back.

**Walked:** 2026-10-08 on the drill stack: `dc stop api`; fired 04:46:50, fixed 18 s after the page, resolved 04:47:26 (section 7).

### DukaanAiHigh5xxRate

**Critical · SEV1.** More than 1 % of API answers (health probes left out)
have been server errors for 5 minutes, with real traffic. Users see errors
on whatever routes fail: at the POS a failed bill offers Retry (safe), other
screens show their error panel.

**First checks**

1. Which answers: Grafana operations dashboard, "5xx by route"; Prometheus
   `sum by (route, status) (rate(http_requests_total{status=~"5.."}[5m]))`;
   Loki `{service="api"} | json | message_event="http" | message_status >= 500`;
   without Loki, `dc logs --since 10m api | grep '"event":"http"' | grep '"status":5'`
   (one access line per answer: `route`, `status`, `correlationId`).
2. Which code: an answer with a code names its cause.
   - 503 `DATABASE_UNAVAILABLE`: the database is away; follow
     **DukaanAiDependencyDown** (it fires too after 2 minutes).
   - 507 `STORAGE_FULL`: follow **DukaanAiStorageFull**.
   - 500 without a code: a fault. Take a `correlationId` from an access
     line; its error line (context `GlobalExceptionFilter`) names the
     cause: Loki `{service="api"} | json | message_correlationId="<id>"`,
     or `dc logs --since 15m api | grep <id>`; the error tracker has the
     stack (Sentry, tag `correlationId`). `Prisma error P2021` / `P2022`:
     a table / column the code reads does not exist.
3. Did it start with a deploy (`dc ps` shows the image tag and its age; the
   release thread)? Did it start with a migration or a change made by hand
   on the database?

**Fix**

- *After a deploy*: roll back to the previous tag (`RELEASE.md`), then
  investigate on staging.
- *One route failing on a database error* (`Prisma error P20xx`, a refused
  privilege, `ER_...`): `migrate status` compares the migration history
  only; it answered "Database schema is up to date!" while a column the
  code reads was missing (found walking this page). Compare the live
  schema with the image's:
  `dc run --rm --no-deps migrate sh -c '/app/node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code'`.
  Exit 0 is no drift; exit 2 lists every table and column that differ.
  - A pending migration (`dc run --rm --no-deps migrate /app/node_modules/.bin/prisma migrate status`
    lists one): the release step was missed; run it (`dc run --rm migrate`).
  - Drift: the schema was changed by hand, or a database from another
    release was restored. Undo exactly what the diff names. A renamed
    column reads as one removed and one added: rename it back (`ALTER TABLE
    ... RENAME COLUMN`), never apply a generated script that drops a column
    holding data. Find out who changed it (the review records it).
  - A privilege lost on the managed database: restore it in the provider's
    console.
- *A fault in code* (a stack in our source): roll back if a release
  introduced it; otherwise mitigate (a feature the shops can live without
  is avoided, the shops told by S2) and fix through a release.

**Verify.** The ratio back under 1 % for 10 minutes; the drift check exits
0 if the cause was the schema; a test sale on the smoke shop
(`scripts/smoke-remote.sh https://<WEB_HOST> https://<API_HOST>` on
staging; production takes `--probes-only`); if bills failed, reconcile the
affected shops' day (section 4): CLEAN.

**Tell the shops.** S1 when billing routes fail, S2 otherwise; S4.

**Walked:** 2026-10-08 on the drill stack: a column the code reads renamed on the database under steady traffic; fired 05:19:34, resolved 05:22:50 (section 7).

### DukaanAiDependencyDown

**Critical.** Every API instance has failed to reach a dependency
(`dependency` label) for 2 minutes. `database`: SEV1, sign-in, sales and
every page answer 503 `DATABASE_UNAVAILABLE` ("please retry in a few
seconds"; the POS Retry keeps the same key, so nothing is billed twice).
`redis`: SEV2, sales continue (stock keys, cache and rate-limit counters
fall back in-process) but background work waits: outbox relays, webhooks,
imports, the dashboard cache. While this fires the readiness probe's
`DukaanAiEndpointDown` is held back, and it keeps firing for 2 minutes after
the dependency is back so the probes recover first.

**First checks**

1. `curl -sS https://<API_HOST>/api/health/ready`: which check is `down`.
2. `database`: the provider's status page and the instance's metrics
   (CPU, connections, storage, maintenance events). From the host, with the
   backup scripts' own connection check (the db-ops image carries the client
   and reads `DATABASE_URL`):
   `dc --profile ops run --rm --no-deps --entrypoint bash db-ops -c '. /scripts/db/lib.sh && load_connection && assert_server && echo database answers'`
   prints `cannot connect to MySQL at <host>` while it is down.
3. `redis`: the provider's status page; from the host
   `dc exec api node -e "new (require('ioredis'))(process.env.REDIS_URL).ping().then(console.log,console.error).finally(()=>process.exit())"`.
4. Was there a credential rotation or a network change (the secrets
   register, `docs/SECRETS.md`)?

**Fix**

- *Instance stopped, failing over or in maintenance*: wait for the provider
  (a failover takes 1 to 2 minutes; the API reconnects on its own, no
  restart needed), or start it.
- *Too many connections*: the instance's connection limit against
  `connection_limit` in `DATABASE_URL` times the API instances; raise the
  instance's limit or lower the pool.
- *Credential or TLS error after a rotation*: correct `DATABASE_URL` /
  `REDIS_URL` in `.env` (the register says where the current value lives),
  `dc up -d api`.
- *Storage full on the database instance*: grow it in the provider's
  console (writes fail until then).

**Verify.** Readiness 200; the alert resolved (2 minutes after recovery);
`DukaanAiOutboxLag` does not follow (the relays catch up within minutes);
for `database`, reconcile the day of the shops that were billing (CLEAN).

**Tell the shops.** `database`: S1, then S4. `redis`: nothing unless a
shop waits on an import or a webhook.

**Walked:** 2026-10-08 on the drill stack: `dc stop mysql`, twice (check 2 as first written started the database again); fired 04:59:33, resolved 05:02:14 (section 7).

### DukaanAiStorageLow

**Warning · SEV3.** A volume (`volume` label: `storage` for documents under
`STORAGE_ROOT`, `uploads` for uploads in flight) has had less than 10 %
free for 15 minutes. Nothing fails yet; at 2 % documents are refused.

**First checks**

1. Which volume and how fast it fills: Grafana, `storage_volume_free_bytes`
   by volume over 7 days.
2. What takes the space, in the container's own shell (a variable outside
   `sh -c '...'` is expanded by your shell, where it is empty, and `du`
   then measures the container's root):
   `dc exec api sh -c 'du -sh "$STORAGE_ROOT"/* | sort -h | tail'`, and the
   uploads volume (`/app/uploads`: `imports/`, `exports/`, `tmp/`).
   Everything the API writes under `STORAGE_ROOT` lives in a directory
   named by a shop id (`<shopId>/Customers`, `<shopId>/Backups`,
   `<shopId>/System`). A top-level entry that is not a shop id was put
   there by something else (a script, an export sent to the wrong
   directory): `dc exec api sh -c 'ls -la --time-style=full-iso "$STORAGE_ROOT"'`
   says when.

**Fix**

- *Normal growth*: grow the disk (`docs/DEPLOYMENT.md`, "Production
  topology": the documents disk is a snapshotted cloud disk; grow it in the
  provider's console, then `resize2fs`).
- *Reproducible files*: import files older than a month under
  `uploads/imports` and stale exports may be removed.
- *Something that does not belong there* (a top-level entry that is not a
  shop id): move it off the volume, then find and stop what wrote it.
  Never delete inside a shop's directory (customer documents, the
  documents backup's source).

**Verify.** Free space above 10 %, the alert resolved.

**Tell the shops.** Nothing.

**Walked:** 2026-10-08 on the drill stack: an export written into the documents volume; fired 06:29:47, resolved 06:32:49 (section 7).

### DukaanAiStorageFull

**Critical · SEV2.** A volume has less than 2 % free. Bill photos, invoice
PDFs and statements are refused with 507 `STORAGE_FULL` ("Nothing was
saved; try again once space has been freed"); nothing partial is kept, so
the same upload succeeds once space is back. Sales are not affected.

**First checks**

1. Which volume (`volume` label) and `df -h` on the host for its mount.
2. What filled it: `du` as in **DukaanAiStorageLow**; a sudden jump is
   usually one process (an export loop, a backup written to the wrong
   directory).

**Fix.** Free space now: stop the process that fills it, move what does
not belong on the volume off it (check 2 of **DukaanAiStorageLow**), remove
reproducible files; then grow the disk as in **DukaanAiStorageLow** unless
the cause is gone. Both storage alerts clear on the next scrape.

**Verify.** A bill photo stored from Smart Capture on the smoke shop; the
alert resolved; `DukaanAiHigh5xxRate` quiet (507s count as 5xx).

**Tell the shops.** S2 ("saving bill photos and documents") if it lasts
more than 15 minutes; S4.

**Walked:** 2026-10-08 on the drill stack: the same export filling the volume, a bill photo answered 507; fired 06:31:59, resolved 06:32:49 (section 7). Again at 07:41 to prove the hold: an API restart left it firing.

### DukaanAiUnhandledErrors

**Warning · SEV3, SEV2 if a shop reports it.** More than 5 server-side
errors reached error tracking in 15 minutes (`kind` = `unhandled` or
`prisma`). It catches faults when traffic is too low for the 5xx ratio.

**First checks**

1. The error tracker: the issues of the last 15 minutes, each with its
   `correlationId`, route, shop and user tags. Without one (no
   `SENTRY_DSN`), the API log has the same lines:
   `dc logs --since 15m api | grep '"context":"GlobalExceptionFilter"'`.
2. The same request in Loki by correlation id: what the user did before.
3. `kind=prisma`: an unmapped database error (`Prisma error P20xx`: a
   schema or privilege problem). `migrate status` misses a change made by
   hand; run the drift check of **DukaanAiHigh5xxRate**.

**Fix.** As in **DukaanAiHigh5xxRate**: a release rolled back, a privilege
or migration restored, the schema put back, or a code fix through a
release. A single shop's data shape that trips a bug: note the shop and
the route, tell the shop the workaround (S3).

**Verify.** No new events for 15 minutes; the alert resolved (it holds
until the last error leaves the 15-minute window, so it clears about 15
minutes after the fix, not at it).

**Tell the shops.** The affected shop only, if any.

**Walked:** 2026-10-08 on the drill stack, with **DukaanAiHigh5xxRate**; fired 05:14:33, resolved 05:35:46 (section 7).

### DukaanAiLedgerPostingFailures

**Critical · SEV1.** A ledger posting threw in the last 10 minutes
(`source` label: SALE, RETURN, CUSTOMER_PAYMENT, GRN...). The business
transaction it belonged to was rolled back: the user saw an error and
nothing was written (the ledger stays consistent). Repeated failures mean
bills, returns or payments are being refused. A session holding ledger
rows looks like this at the counter: the Charge button waits about 50
seconds (the database's lock wait timeout), then "The database is
unavailable at the moment. Please retry" (503 `DATABASE_UNAVAILABLE`),
while `/api/health/ready` stays 200 and **DukaanAiDependencyDown** stays
quiet. That combination means a lock, not an outage.

**First checks**

1. Which `source`: Prometheus
   `sum by (source) (increase(ledger_posting_failures_total[10m]))`.
2. The API log around the failures (the posting service writes no line of
   its own): `dc logs --since 15m api | grep -E '"level":"(warn|error)"'`,
   or Loki `{service="api"} | json | message_context=~"BillingService|GlobalExceptionFilter"`.
   - `Transaction rolled back by the database on attempt N, retrying`
     followed by `Database unavailable ...`: a lock wait or a deadlock;
     go to check 3.
   - `Unbalanced ledger posting ...`: a code defect (money computed
     outside `@dukaanai/invoice-math`).
3. Lock waits, at a SQL prompt as the database administrator (section 4):
   `SELECT wait_age, locked_table, waiting_pid, waiting_query, blocking_pid, blocking_trx_started, blocking_trx_age, blocking_trx_rows_locked, sql_kill_blocking_connection FROM sys.innodb_lock_waits;`
   It names the blocking connection and the statement that ends it. The
   waiting query carries the shop id (`LedgerAccountBalance` rows are
   `<shopId>:<ACCOUNT>`). A sale waits only while it waits: with no row
   here, `SELECT trx_mysql_thread_id, trx_started, trx_rows_locked, trx_query FROM information_schema.innodb_trx ORDER BY trx_started;`
   shows the transaction that has been open for minutes (a client left in
   a transaction is `Sleep` in the processlist with no query, so the
   processlist alone never shows it). `performance_schema.data_lock_waits`
   gives thread ids, not the connection ids `KILL` takes: use the view.
   Deadlocks: `SHOW ENGINE INNODB STATUS` (LATEST DETECTED DEADLOCK).

**Fix**

- *A stuck transaction holding ledger rows* (a manual session left open, a
  hung process): note who it is (`SELECT ID, USER, HOST, COMMAND, TIME FROM information_schema.PROCESSLIST WHERE ID = <blocking_pid>`),
  then end it with the view's `KILL <blocking_pid>` (a managed database may
  name its own procedure, e.g. `CALL mysql.rds_kill(<id>)` on RDS). The
  sale waiting at that moment completes at once and the POS's Retry
  succeeds. Find out why the session was left open; the review records it.
- *Deadlocks under load*: they are retried automatically
  (`withSerializationRetry`); persistent ones mean a new code path takes
  locks out of the canonical order (CLAUDE.md, "Lock order"): roll back the
  release that added it.
- *Unbalanced posting*: a defect; roll back the release; never post a
  correcting entry by hand.

**Verify.** No failure for 10 minutes (the alert clears 10 minutes after
the last one); a test sale; reconcile the affected shops' day: CLEAN (a
failed posting wrote nothing, so CLEAN is expected). A checkout that
waited and then completed can also hold **DukaanAiCheckoutSlow** pending
for the next 10 minutes.

**Tell the shops.** S1 while bills fail; S4.

**Walked:** 2026-10-08 on the drill stack: a session holding one shop's ledger balance rows; the first refused sale did not page (fixed), the retry did at 05:43:50; resolved 05:54:17 (section 7).

### DukaanAiCheckoutSlow

**Warning · SEV2 if cashiers notice.** The 95th percentile of completed
checkouts has been over 500 ms for 10 minutes (baseline: well under at 3x
peak, `docs/LOAD_TEST_BASELINE.md`). Cashiers wait on the Charge button.

**First checks**

1. Is it every shop or one? The access lines of the checkout carry `ms`
   and `userId` (not the shop):
   `dc logs --since 10m api | grep '"route":"/api/billing/invoice"'`,
   grouped by `userId`; the slow users' shop:
   `SELECT u.id, s.name FROM User u JOIN Shop s ON s.id = u.shopId WHERE u.id IN (...)`.
2. Lock waits on the database: one shop bills serially by design (shift,
   number sequence and product rows are locked in order), so a shop with
   many terminals and one product in every bill queues on that product. A
   slow checkout's waits last under a second, so one look at
   `sys.innodb_lock_waits` (section 4's SQL prompt) usually shows nothing:
   sample it, `for i in $(seq 10); do mysql ... -e "SELECT locked_table, waiting_pid, blocking_pid, blocking_trx_age FROM sys.innodb_lock_waits"; sleep 0.3; done`,
   and read `SHOW GLOBAL STATUS LIKE 'Innodb_row_lock%'` twice a minute
   apart: `Innodb_row_lock_waits` growing with every checkout and
   `Innodb_row_lock_time_avg` near the checkout time mean the checkouts
   wait on rows. The `blocking_pid` that recurs is the session; the
   processlist names it (a session that holds a row in turns shows as
   `Sleep` between its transactions).
3. The database instance: CPU, IOPS, slow query log; Redis latency.
4. The API: CPU and event-loop lag (`dukaanai_nodejs_eventloop_lag_seconds`).

**Fix**

- *A session holding a shop's rows* (an integration or a script that
  locks product rows in turns): note who it is, end it as in
  **DukaanAiLedgerPostingFailures** (`KILL <blocking_pid>`), and stop what
  runs it, or it reconnects.
- *Instance saturated*: scale the database instance; check for a report or
  an import running at the same time (imports are background jobs but use
  the same database).
- *After a release*: compare with the previous tag on staging (the load
  test, `apps/api/load`); roll back if it regressed.

**Verify.** The slow shop's checkouts are quick again at once; the alert
clears when its 10-minute window no longer holds the slow ones (about 10
minutes after the fix). With only a few checkouts in a quiet hour, one
slow checkout is the whole p95 (a sale that waited on a lock, see
**DukaanAiLedgerPostingFailures**): read the access lines before
anything else.

**Tell the shops.** Only the shops that called.

**Walked:** 2026-10-08 on the drill stack: a product row held in turns during one shop's checkouts; fired 06:34:04, resolved 06:43:33 (section 7).

### DukaanAiOutboxLag

**Warning · SEV2 when it delays what shops see.** The oldest outbox row
waiting to be relayed is more than 5 minutes old, for 10 minutes. Sales are
unaffected; what follows a sale waits: low-stock notifications, dashboard
cache invalidation by the event, webhooks to the shop's integrations,
purchase events.

**First checks**

1. Is anything relaying? The three relays (`EventsOutboxRelayService` every
   5 s, `PurchaseOutboxRelayCron` and `OutboxProcessorWorker` for product events
   every second) run on every instance unless it was started with
   `CRON_ENABLED=false` (no compose file or manifest sets it; empty means
   on). They take no Redis lock (`SKIP LOCKED` keeps instances apart), so
   there is no lock to wait for: `dc exec api printenv CRON_ENABLED`, and
   the boot log line `schedule not registered: CRON_ENABLED=false`.
2. What waits, and in which state:

   ```sql
   SELECT type, status, createdAt, claimedAt, retryCount, nextAttemptAt, LEFT(error, 120) AS error
   FROM OutboxEvent WHERE status IN ('PENDING', 'CLAIMED', 'PROCESSING') ORDER BY createdAt LIMIT 10;
   ```

   - PENDING with `nextAttemptAt` in the past: nothing relays them (check 1).
   - PENDING with `nextAttemptAt` in the future and the error
     `stale claim: no worker finished it`: they were handed to a queue and
     nobody took them within `EVENTS_OUTBOX_STALE_CLAIM_MS` (5 minutes); the
     reaper gave them back and they will be handed over again (check 3).
     After `EVENTS_OUTBOX_MAX_RETRIES` (5) handovers they are FAILED with
     that error (**DukaanAiOutboxFailedRows**).
   - PENDING with another `error`: the worker failed them and they back
     off; the error says why.
   - CLAIMED (the claim clears the error): handed to a queue, not finished
     yet (check 3).
3. The queue behind the family (`system-events`, `purchase-events`,
   `webhook-delivery`): `queue_paused` is 1 for a paused queue (the pause is
   kept in Redis: `dc exec redis redis-cli HGET bull:<queue>:meta paused`
   answers `1`, and a restart does not lift it); `queue_jobs{state="waiting"}`
   growing while `state="active"` stays 0 means no worker takes jobs.
   Worker errors are in the logs (`SystemEventsProcessor`,
   `EventsProcessorService` for purchase events, `WebhookDeliveryWorker`).
4. Redis reachable (`DukaanAiDependencyDown` would say so).

**Fix**

- *Schedules off* (someone gave an instance `CRON_ENABLED=false`): remove it
  on one instance, `dc up -d api`. The waiting rows go out within seconds.
- *Paused queue*: find out who paused it and why, then resume it. A
  restart does not resume a queue: the pause is stored in Redis. Every
  handover left a job in the queue (one per row and attempt): they run in
  turn, the first marks the row DONE, the others find it handled and skip
  (the worker's idempotency marker), and rows the reaper had FAILED end
  DONE too (the walk: 11,552 jobs drained in two minutes, every row of
  2,420 DONE, each event handled once).
  `dc exec api node -e "const {Queue}=require('bullmq');const q=new Queue('<queue>',{connection:{url:process.env.REDIS_URL}});q.resume().then(()=>q.close())"`.
- *Worker failing every job*: its error in the logs; a code defect is
  rolled back; a webhook target that refuses is **DukaanAiOutboxFailedRows**.

**Verify.** `outbox_oldest_pending_age_seconds` back under a minute; the
alert resolved.

**Tell the shops.** Nothing unless a shop's integration depends on webhooks.

**Walked:** 2026-10-08 on the drill stack: `system-events` paused during 1,500 sales; fired 06:27:59, resolved 07:10:32 after the resume, held 40 minutes on purpose (section 7).

### DukaanAiOutboxFailedRows

**Warning · SEV3.** Outbox rows exhausted their retries
(`EVENTS_OUTBOX_MAX_RETRIES`) and are FAILED. Each carries its last error.
What they would have triggered (a webhook, a notification) did not happen.

**First checks**

1. Which rows, across shops (on the database, read only):

   ```sql
   SELECT shopId, type, LEFT(error, 120) AS error, COUNT(*) AS n, MAX(processedAt) AS lastFailed
   FROM OutboxEvent WHERE status = 'FAILED' GROUP BY shopId, type, LEFT(error, 120) ORDER BY lastFailed DESC LIMIT 20;
   ```

   A manager of a shop sees its newest 100 with
   `GET /api/sales/events?status=FAILED` (no count header).
2. The error says why:
   - `stale claim: no worker finished it` (the reaper's): each handover
     went to a queue nobody worked, a stopped or paused worker
     (**DukaanAiOutboxLag** check 3). The jobs of those handovers are still
     in the queue.
   - Anything else: a webhook target that refuses or is not public (the
     SSRF guard), a listener defect, a removed product.

**Fix.** Fix the cause first:

- *Stale claims*: resume the queue or bring its worker back
  (**DukaanAiOutboxLag**). The queued jobs run in turn and end every row
  DONE, the FAILED ones included, each event handled once; wait until
  `queue_jobs{state="waiting"}` is 0 and re-queue only what is still
  FAILED then (a queue emptied by hand, or a Redis that lost its data,
  leaves them FAILED).
- *A webhook target or a defect*: the shop corrects its webhook URL; a
  defect is fixed by a release.

Then re-queue each remaining row as a manager of its shop:
`POST /api/sales/events/retry {"eventId":"<outboxEventId>"}` (201; 409
`OUTBOX_EVENT_NOT_FAILED` when it is not FAILED any more). The list shows
the newest 100, so with more, repeat this pass (`TOKEN`: a manager's access
token from `POST /api/auth/login`) until it lists nothing:

```
curl -fsS "https://<API_HOST>/api/sales/events?status=FAILED" -H "authorization: Bearer $TOKEN" | jq -r '.[].id' | while read -r id; do curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://<API_HOST>/api/sales/events/retry" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"eventId\":\"$id\"}"; done | sort | uniq -c
```

Across many shops after a defect fix, the operator makes the route's own
change on the database, read by a second person (`retryCount` must
advance: it names the fresh job):
`UPDATE OutboxEvent SET status = 'PENDING', claimedAt = NULL, nextAttemptAt = NULL, error = NULL, retryCount = retryCount + 1 WHERE status = 'FAILED' AND type = '<type>' AND processedAt >= '<UTC since>'`.
A row whose event no longer matters is left FAILED (retention keeps
FAILED rows).

**Verify.** `outbox_rows{status="FAILED"}` back to 0 (or only the rows you
chose to leave); the alert resolved two minutes later (the hold).

**Tell the shops.** The shop whose integration missed events, with the
time range.

**Walked:** 2026-10-08 on the drill stack: the same paused queue until the reaper failed 1,429 rows; fired 07:04:35, resolved 07:09:32 (section 7); the retry pass and the cross-shop reset run as written at 07:48.

### DukaanAiBackupStale

**Critical · SEV2.** A backup job has not succeeded in time (`kind`:
`binlog` 15 minutes, `dump`, `documents` and `offsite` 26 hours). Nothing
fails for users, but the recovery point grows (`docs/DATA_SAFETY.md`): a
database loss now would lose more than the promised 5 minutes.

**First checks**

1. `dc --profile ops run --rm --no-deps db-ops status`: every job's last success.
2. Is the job running at all? `dc ps -a binlog-archiver backup-agent` (an
   `Exited` service was stopped and nothing started it again; its log ends
   at its last success and says nothing more). Then the job's own log:
   `dc logs --since 2h binlog-archiver` / `backup-agent`; on Kubernetes
   the `backup-agent` sidecar.
3. The usual causes: the backups volume full (`df -h` on it), a privilege
   lost by the backup user (RELOAD, REPLICATION CLIENT / SLAVE), the
   off-site remote unreachable or its key wrong, the agent not running.

**Fix.** Correct the cause, then run the late job by hand and read its
output: `dc --profile ops run --rm --no-deps db-ops binlog-archive --flush`,
`... db-ops backup`, `... db-ops documents-backup`, `... db-ops offsite push`.
Each success stamps the status directory the metric reads.

**Verify.** `db-ops status` shows a fresh success for the kind; the alert
resolved within a scrape.

**Tell the shops.** Nothing.

**Walked:** 2026-10-08 on the drill stack: the binlog archiver stopped; fired 06:33:34, resolved 06:35:02 (section 7).

### DukaanAiBackupNeverRecorded

**Warning · SEV3.** There is no `backup_last_success_timestamp_seconds`
series for a backup kind, for 30 minutes: as far as monitoring knows, that
job has never succeeded. On a new stack it fires until the first nightly
run; on a running stack it means the job, or the stamp, is gone.

**First checks**

1. `dc --profile ops run --rm --no-deps db-ops status`: is the kind listed?
2. Is the job scheduled (the `binlog-archiver` service, the `backup-agent`,
   or host cron)?
3. Can the API read the stamps? `BACKUP_STATUS_DIR` on the API and the
   jobs must name the same directory, and the `db-backups` volume is
   mounted into the API read-only (`dc exec api sh -c 'ls -l "$BACKUP_STATUS_DIR"'`).

**Fix.** Schedule the job, or align `BACKUP_STATUS_DIR` / the mount, then
run the job once by hand (as in **DukaanAiBackupStale**).

**Verify.** The series exists (Prometheus:
`backup_last_success_timestamp_seconds`); the alert resolved.

**Tell the shops.** Nothing.

**Walked:** 2026-10-08 on the drill stack: the off-site job's stamp removed; fired 06:44:35, resolved 06:45:31 (section 7).

### DukaanAiReconciliationDrift

**Critical · SEV1 when money moved, else SEV2.** A shop's newest
reconciliation run (nightly, or run by hand) ended in DRIFT or FAILED: its
documents, ledger, tenders, stock or shifts disagree somewhere. The job
never corrects anything.

**First checks**

1. Which shops: on the database, read only:
   `SELECT shopId, businessDate, status, driftCount FROM ReconciliationRun
   ORDER BY createdAt DESC LIMIT 20`, or the shop's owner reads
   `GET /api/reconciliation/latest`.
2. Read the run: every drift names its check (`documents`, `postings`,
   `tenders`, `dashboard`, `shifts`, `stock`, `ledger`), the document or
   row, and the expected and actual figures (contract §11). A FAILED run
   carries the error.
3. Find the write that produced the row: the document's audit rows
   (`AuditLog` by `entityId`), its stock-ledger entries
   (`StockLedgerEntry` by `inventoryItemId`), its correlation id in Loki,
   what else happened to it that day (a return, a cancellation, an
   adjustment). A change that none of them explains was made outside the
   application; the binary log shows when and in which session:
   `dc --profile ops run --rm --no-deps -T --entrypoint bash db-ops -c '. /scripts/db/lib.sh && load_connection && mysqlbinlog --read-from-remote-server $(conn_args) --base64-output=decode-rows -v --start-datetime="<UTC from>" --stop-datetime="<UTC to>" <binlog file>' | grep -B20 -A30 '<row id>'`
   (`SHOW BINARY LOGS` names the files; archived ones are in the backups
   volume). A transaction that touched only that row, with no ledger entry
   and no audit row, is a change made by hand.

**Fix**

- *A FAILED run* (the engine threw: database away during the run, a
  timeout): run it again (`dc exec api node dist/cli/reconcile --shop <id>
  --date <day>`, or the owner's `POST /api/reconciliation/run
  {"date":...}`); CLEAN closes it.
- *A real drift*: the owner decides the correction; it is made in the
  application (a stock adjustment, a cancellation and re-bill, a repayment)
  with a note that names the run, never in the database. If a code defect
  wrote the bad row, the defect is fixed first (a release) so it does not
  happen again.
- *A change made outside the application* (check 3): the application
  cannot correct it (an adjustment moves the ledger too, so the drift
  stays). Undo exactly that write, guarded on the drifted value
  (`UPDATE ... SET onHand = onHand - 5 WHERE id = '<row>' AND onHand = <drifted>`),
  with a second person reading it; then, if the shop's count really
  differs, record it in the application as above. The review records who
  made the change and why.
- *Many shops drift the same way overnight*: a defect in a release; roll
  back and reconcile again after the fix.

**Verify.** The shop's day reconciles CLEAN after the correction
(`dc exec api node dist/cli/reconcile --shop <id> --date <day>`, exit 0);
the alert resolved (it reads the latest run per shop).

**Tell the shops.** S6 to the shop whose books were corrected, after the
owner approves the text.

**Walked:** 2026-10-08 on the drill stack: a stock row changed on the database by hand; fired 06:16:29, resolved 06:17:59 (section 7).

### DukaanAiReconciliationStale

**Warning · SEV3.** No reconciliation run has finished anywhere for 26
hours: the nightly job is not running. Drift, if any, goes unseen.

**First checks**

1. When it should have run: `CRON_RECONCILIATION` (default `30 1 * * *`,
   the container's clock, UTC: 07:00 in India) and whether an instance
   carries `CRON_ENABLED=false` (`dc exec api printenv CRON_ENABLED`; empty
   is on; the boot line `Reconciliation schedule not registered` says off).
2. The API's log around that time, in Loki: `{service="api"} |~
   "Reconciliation|cron:reconciliation"` over the last 30 hours. `dc logs`
   holds only the running container, and a deploy since 01:30 took the
   night's lines with it (`dc ps` says when it started).
   `Reconciliation: N row(s) across M shop(s), K failed` is a run;
   `Reconciliation sweep crashed: ...` a run that died before writing
   (the database away at 01:30); `Could not acquire lock
   cron:reconciliation` a run skipped while Redis was away; nothing at all
   means the API was not running at 01:30 (a deploy, a crash), or another
   instance held the lock (that one logs only at debug).
3. The lock in Redis: `dc exec redis redis-cli TTL cron:reconciliation`
   (-2: free; a held lock expires by itself after 30 minutes).

**Fix.** Correct what check 1 or 2 found (the schedule, the instance
that was down); then run the missed night in the API container:
`dc exec api node dist/cli/reconcile --all-shops` reconciles every shop's
previous business day, which is what the nightly run would have done
(`--date <day>` for an older night; one shop: `--shop <id> --date <day>`,
or its owner's `POST /api/reconciliation/run {"date":"<day>"}`). It
records a run per shop (trigger `CLI`), prints each, and exits 1 when a
shop drifted (**DukaanAiReconciliationDrift** follows). A cron run does
not catch up: a missed night stays missed until someone runs it.

**Verify.** The command's last line: `N clean, 0 with drift, 0 failed`;
the alert resolved two minutes later (the hold).

**Tell the shops.** Nothing.

**Walked:** 2026-10-08 on the drill stack: every run made 27 hours old; fired 07:10:32, resolved 07:31:04 once the command shipped in the image (section 7).

### DukaanAiQueueBacklog

**Warning · SEV2 when shops wait.** More than 1,000 jobs have waited on a
BullMQ queue (`queue` label) for 15 minutes: its worker is not keeping up
or not running. Depending on the queue: imports wait (`import-job`),
webhooks are late (`webhook-delivery`), notifications and cache
invalidation wait (`system-events`), images are not processed
(`media-processing`).

**First checks**

1. `queue_paused` and `queue_jobs` by queue and state (Prometheus or
   Grafana): paused 1 is a queue someone paused (the pause is kept in
   Redis, a restart does not lift it; its jobs count as waiting); waiting
   growing with active 0 is a worker that does not take jobs; active
   steady is a slow worker.
2. The worker's errors in the logs; a worker that fails every job also
   fills the failed set (**DukaanAiQueueFailedJobs**).
3. Redis memory and latency.

**Fix**

- *Paused*: find out who paused it and whether they still need it, then
  resume it:
  `dc exec api node -e "const {Queue}=require('bullmq');const q=new Queue('<queue>',{connection:{url:process.env.REDIS_URL}});q.resume().then(()=>q.close())"`.
  The backlog drains at the worker's pace; for an outbox-fed queue see
  **DukaanAiOutboxLag** (the rows end DONE as their jobs run).
- *Worker not running*: every API instance runs every worker; restart the
  API (`dc restart api`).
- *Worker slow*: add an API instance only after the documents move to
  object storage (one replica until then, `docs/DEPLOYMENT.md`); meanwhile
  find the slow job (a huge import) and let it finish.

**Verify.** Waiting back under 1,000 and falling; the alert resolved.

**Tell the shops.** A shop waiting on an import: S2.

**Walked:** 2026-10-08 on the drill stack: `system-events` paused during 1,500 sales; fired 06:38:46, resolved 07:10:42 (section 7).

### DukaanAiQueueFailedJobs

**Warning · SEV3.** A queue holds jobs that failed every attempt, for 30
minutes. Each kept its data and its last error in Redis; outbox-backed jobs
also marked their outbox row FAILED.

**First checks**

1. The failed set: from the API container
   `node -e "const {Queue}=require('bullmq');const q=new Queue('<queue>',{connection:{url:process.env.REDIS_URL}});q.getFailed(0,9).then(j=>{console.log(j.map(x=>({id:x.id,name:x.name,reason:x.failedReason})));process.exit()})"`.
2. The reason: a job for a removed document (harmless), a defect, a
   dependency that was away.

**Fix.** Fix the cause, then retry the jobs that still matter or remove
the ones that cannot succeed, from the same shell:
`dc exec api node -e "const {Queue}=require('bullmq');const q=new Queue('<queue>',{connection:{url:process.env.REDIS_URL}});q.getJob('<id>').then(j=>j.retry()).then(()=>process.exit())"`
(`j.remove()` instead of `j.retry()` to drop it). An import job that failed
is simply uploaded again (it is idempotent). A photo that cannot be decoded
(`VipsJpeg: premature end of JPEG image`: cut off in transit) fails every
attempt: remove the job and ask the shop to upload the photo again; the
broken entry stays in the product's gallery, since no route removes a
media asset yet (defect log, `docs/PILOT.md`).

**Verify.** `queue_jobs{state="failed"}` back to 0 for the queue; the alert
resolved.

**Tell the shops.** Nothing, unless an import of theirs failed.

**Walked:** 2026-10-08 on the drill stack: a photo cut off in transit failing its thumbnail job; fired 06:49:44, resolved 06:50:36 (section 7).

### DukaanAiCredentialFlood

**Warning · SEV2 if real users are locked out.** The credential routes
(`/api/auth/*`) have refused more than one attempt every 10 seconds with
429 for 10 minutes: a brute-force or credential-stuffing run. The limits
are holding (`docs/PRODUCTION_LIMITS.md`); the risk is a real user locked
out of their account for the lockout window.

**First checks**

1. The source addresses of the refusals, last 5 minutes: Loki
   `{service="api"} | json | message_event="http" | message_status=429 |
   message_route=~"/api/auth/.*"` (`message_ip`), or
   `dc logs --since 5m api | grep '"event":"http"' | grep '"status":429' | grep '"route":"/api/auth/' | grep -o '"ip":"[^"]*"' | sort | uniq -c`.
   The address is the one the edge accepted the connection from (a
   client's own `X-Forwarded-For` is discarded there).
2. One address or many, and which accounts: the attempts that got past
   the throttle are `AuthService` lines (`Login refused for ...: unknown
   account | wrong password | account locked ...`), each with the `ip` and
   the `correlationId` of its access line:
   `dc logs --since 15m api | grep '"context":"AuthService"' | grep 'Login refused'`.
   Many addresses against one account means the per-account throttle and
   the lockout are doing the work: check that account's owner is not
   locked out (`User.isLocked`, `lockedUntil`). Unknown accounts only:
   nobody's account is at risk.
3. Is the address the shop's own (a misconfigured integration retrying)?

**Fix**

- *One or a few addresses*: block them at the edge for 24 hours and record
  them: `EDGE_BLOCKED_IPS="<address> <range>/<bits>"` in `.env` (space
  separated), then `dc up -d edge`; the edge answers them 403 before they
  reach the web or the API. Kubernetes: the Ingress annotation
  `nginx.ingress.kubernetes.io/denylist-source-range`. Behind a cloud load
  balancer, its firewall. Remove the entry after the 24 hours (`dc up -d
  edge` again). Recreating the edge cuts the requests in flight at that
  second: in the walk one sale lost its answer and was not written; the
  POS's Retry sends it again under the same key.
- *A distributed run*: leave the limits to work; if a real owner is locked
  out, they reset their password (the lock ends on its own after
  `SECURITY_LOCKOUT_DURATION_MS`).
- *A shop's integration*: tell the shop to fix its credentials.

**Verify.** The blocked address gets 403 from the edge and no longer
appears in the API's access log; the 429 rate falls under the threshold
(the alert clears about 5 minutes after the block, the rate's window).

**Tell the shops.** The account's owner if their account was targeted
(S7's wording when a password reset is advised).

**Walked:** 2026-10-08 on the drill stack: wrong passwords from one host through the edge; fired 06:25:40, resolved 06:32:00 (section 7).

### DukaanAiEmailDeliveryFailing

**Warning · SEV2.** The mail relay refused or could not take a message of
a `purpose` (invitation, password reset, password changed) in the last 30
minutes. Invitations answered the owner 502 `INVITATION_EMAIL_FAILED` (and
kept nothing, so they can repeat it); a reset link was voided while the
user was told it had been sent: sign-in recovery is broken until this is
fixed.

**First checks**

1. The relay's reply, in the API log:
   `dc logs --since 30m api | grep 'was not accepted by the relay'`.
   `535` credentials, `550`/`553` sender or recipient refused,
   `ECONNECTION`/`ETIMEDOUT` relay unreachable, a quota message. The
   deployed relay address without its password:
   `dc exec api printenv SMTP_URL | sed -E 's#(://[^:]*):[^@]*@#\1:***@#'`.
2. The provider's dashboard: quota, suspension, the sending domain's
   SPF/DKIM status.

**Fix.** Correct `SMTP_URL` (credentials rotated, `docs/SECRETS.md`) or
`EMAIL_FROM` (a verified sender), restart the API; ask the provider to lift
a suspension. Then send an invitation to yourself from the smoke shop.

**Verify.** Your invitation arrives; no failure for 30 minutes; the alert
resolved.

**Tell the shops.** Users who asked for a reset meanwhile request it again
(the shops that called).

**Walked:** 2026-10-08 on the drill stack: the relay password rotated at the provider; fired 06:09:06, resolved 06:38:50 (section 7).

### DukaanAiEndpointDown

**Critical · SEV1.** A blackbox probe has failed for 2 minutes: the
readiness route (`/api/health/ready`) or the login page, through the edge
or inside. It is what a shop sees from outside. Held back while
`DukaanAiApiDown` fires, while `DukaanAiDependencyDown` fires (readiness
probes), and while `DukaanAiCertificateExpired` fires for the same address.

**First checks**

1. Which probe (`instance`, `job`): readiness or login page, edge or
   internal.
2. Readiness failing: `curl -sS https://<API_HOST>/api/health/ready` names
   the dependency (then its runbook); `draining` means a shutdown is in
   progress.
3. Login page failing: the web container (`dc ps web`, `dc logs --since
   10m web`).
4. Only the edge address failing: the edge (`dc logs --since 10m edge`),
   DNS (`dig +short <WEB_HOST>`), and the certificate: `curl -vI
   https://<WEB_HOST>` (a wrong name, an incomplete chain, an unknown
   issuer fail the probe without expiring).

**Fix.** By cause: the dependency's runbook; restart the web
(`dc restart web`); the edge configuration (`caddy validate`, then
`dc restart edge`); DNS at the registrar; a certificate as in
**DukaanAiCertificateExpired**.

**Verify.** The probe succeeds for 2 minutes; the alert resolved; the login
page loads in a browser.

**Tell the shops.** S1 when the public address is down; S4.

**Walked:** 2026-10-08 on the drill stack: `dc stop web`; fired 04:50:31, resolved 04:51:47 (section 7); held back by **DukaanAiCertificateExpired** at 07:18.

### DukaanAiCertificateExpiring

**Warning · SEV3, SEV2 under 3 days.** The certificate of a public address
expires in under 14 days and has done so for an hour: automatic renewal
has not happened. When it lapses, every browser refuses the address.

**First checks**

1. `echo | openssl s_client -connect <HOST>:443 -servername <HOST> 2>/dev/null | openssl x509 -noout -dates -issuer`.
2. Caddy: `dc logs --since 24h edge | grep -iE 'certificate|acme|challenge'`;
   ports 80 and 443 must reach the edge from the internet, and the DNS
   names must point at it. No ACME line at all, only `skipping automatic
   certificate management because one or more matching certificates are
   already loaded`, means a certificate installed as a file
   (`dc exec edge printenv EDGE_TLS_LINE` names it): nothing renews it.
   Kubernetes: `k describe certificate`, the cert-manager logs.

**Fix.** Automatic renewal: correct what blocks the challenge (firewall,
DNS), then `dc restart edge` (Caddy retries at start); on Kubernetes delete
the failing `CertificateRequest` so cert-manager retries. A file
certificate: copy the renewed certificate and key over the files
`EDGE_TLS_LINE` names (`dc cp <host>.crt edge:/data/certs/<host>.crt`, the
same for the key) and reload the edge in place,
`dc exec edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force`
(a reload keeps connections; a restart cuts the requests in flight), or
return to automatic renewal (blank `EDGE_TLS_LINE`, `dc up -d edge`).

**Verify.** The new certificate's dates (check 1); the alert resolved at
the next certificate probe (every minute).

**Tell the shops.** Nothing.

**Walked:** 2026-10-08 on the drill stack: a file certificate 2 days from expiry; fired 07:12:22, resolved 07:15:23 (section 7).

### DukaanAiCertificateExpired

**Critical · SEV1.** The certificate of a public address has expired: every
browser refuses it (with HSTS there is no way past the warning) and every
client call fails. The probes of the same address are held back while this
fires; it keeps firing for 2 minutes after a renewal is read.

**First checks.** As in **DukaanAiCertificateExpiring**: the dates, the
edge's ACME log, ports, DNS.

**Fix.** Renew now. A file certificate: the renewed files and a reload in
place, as in **DukaanAiCertificateExpiring**. Automatic renewal: correct
what blocks the challenge and restart the edge. If the ACME issuer cannot
issue quickly (rate limits), install a certificate from another issuer as
a file, on the edge's persistent volume (`/data`; the compose files mount
nothing else that survives a recreate): `dc exec edge mkdir -p /data/certs`,
`dc cp <host>.crt edge:/data/certs/<host>.crt` and the key the same way,
`EDGE_TLS_LINE="tls /data/certs/<host>.crt /data/certs/<host>.key"` in
`.env` (one certificate for `WEB_HOST` and `API_HOST`: the line applies
to both), `dc up -d edge`. Return to automatic renewal afterwards: nothing
renews a file.

**Verify.** `curl -sSI https://<WEB_HOST>` succeeds; the POS loads; the
alert resolved and its address's probes recovered.

**Tell the shops.** S1 (the app does not open), S4.

**Walked:** 2026-10-08 on the drill stack: an expired file certificate; fired 07:16:23, resolved 07:21:53 (section 7).

## 6. Post-incident review

Within five working days of every SEV1 and SEV2, and of every drill that
found something, the lead writes the review as
`docs/incidents/<YYYY-MM-DD>-<alert-or-slug>.md` from this template and the
team reads it together. Blameless: the review asks what made the mistake
possible, never who.

```markdown
# <YYYY-MM-DD> <one-line title>

| | |
|---|---|
| Severity | SEV1 / SEV2 |
| Duration | <first user impact> to <resolved>, <minutes> min (IST) |
| Shops affected | <how many, which> |
| Detected by | <alert name, or a shop's call> at <time>; page acknowledged at <time> |
| Time from page to the first correct action | <minutes> (the runbook's own measure) |
| Lead / operator / communicator | <names> |

## What the shops saw
<In their words: which screens, which errors, for how long. Bills affected:
none lost / <n> retried / <n> on paper and entered later.>

## Timeline (IST)
| Time | What happened / what we did |
|---|---|

## Cause
<What broke, and why it could: keep asking "why" until the answer is
something we can change.>

## What went well
## What went badly
## Where we were lucky

## Data
<Reconciliation of the affected shops' days: CLEAN / DRIFT and the
corrections made (with the owner's approval and the S6 message sent).>

## Actions
| Action | Owner | Due | Done |
|---|---|---|---|
<Each action prevents a recurrence, detects it sooner, or shortens the
recovery. Runbook changes are actions too.>

## Messages sent to the shops
<The S1 to S7 messages as sent, with their times.>
```

The runbook of every alert that fired gets its **Walked** line and its row
in section 7 updated with the date and the time from the page to the first
correct action.

## 7. Runbooks walked

Row 9.22's gate: each runbook walked once during the drills of row 9.18.
All 21 were walked on 2026-10-08 (times UTC) on the production-shaped
drill stack of `docs/DRILLS.md` (`scripts/drills/drill-stack.sh`: MySQL 8,
Redis, the API and web images of release candidate `v1.0.0-rc3`, the TLS
edge, Prometheus, Alertmanager and the blackbox exporter), each condition
produced by a fault injected the way it happens in production (the second
column says how): the drills' own faults for the outages, a fault made by
hand for the rest, with real traffic where the alert needs it. The on-call
followed the page as written; where the page was wrong, the walk recorded
it, corrected the page (and the code, where the code was the cause) and
finished the incident with the corrected page. From 06:02 the API ran an
image built from this row's fixes (`walk-e5e56b4`), from 07:30 with the
operator commands as well. "Page to first correct action" is the time
from the alert firing to the first step of the runbook that led to the
fix; "fixed" is the alert resolving after that fix.

| Alert | How it was produced | Fired | Page to first correct action | Fixed | What the walk changed |
|---|---|---|---|---|---|
| `DukaanAiApiDown` | `dc stop api` (container stopped and left down) | 04:44:29 inject; fired 04:46:50 (2 min 21 s) | 18 s: checks 1 to 4 (edge 502, `Exited (0)`, 0 restarts, `Shutdown requested by SIGTERM` last in the log), then `dc up -d api` | resolved 04:47:26; probes-only smoke PASSED | added the cause the page lacked (stopped cleanly: exit 0 after SIGTERM, no restarts); the page now says EndpointDown is held back too (inhibit rule); link to RELEASE.md "Rollback" |
| `DukaanAiHigh5xxRate` | `Notification.message` renamed on the database by hand (a column the code reads is gone), traffic of 2 requests a second over three routes | 05:03:40 rename, 05:13:59 traffic; fired 05:19:34 (5 min 35 s after the traffic) | 62 s: check 1 (`/api/notifications` 500 by route, access log), check 2 (the error line: `Prisma error P2022`, the column does not exist), check 3 (`migrate status`: "up to date"; `migrate diff --exit-code`: exit 2, the column removed and one added), then the column renamed back | resolved 05:22:50; drift check exit 0; remote smoke PASSED | `migrate status` misses a change made by hand: the drift check (`migrate diff --exit-code`) is now on the page, with the warning that a rename reads as a drop plus an add (never apply a generated script that drops a column holding data); the no-Loki access-log grep; the error line carried the request's correlation id only inside its text (`correlationId: "system-job"` as the field), so the Loki query by id missed it: `GlobalExceptionFilter` now logs the id as the field |
| `DukaanAiDependencyDown` | `dc stop mysql` | first try 04:52:05 inject, fired 04:54:30; repeated 04:57:08 inject, fired 04:59:33 (2 min 25 s) | first try: check 2 as written failed (the db-ops entrypoint refuses `sh`, and `dc run` started the stopped database as a dependency, ending the outage); repeated with the corrected command: 17 s (readiness `database: down`, the probe `cannot connect`), then `dc start mysql` | readiness 200 4 s after the start; resolved 05:02:14 (the 2-minute hold); reconciliation CLEAN; no OutboxLag followed | check 2 rewritten (`--no-deps --entrypoint bash` and the backup scripts' own connection check); section 4 says every `dc run` in a check takes `--no-deps`; the Redis check was run as written (PONG) |
| `DukaanAiStorageLow` | an export written into the documents volume (`Backups/tmp-export`, not a shop's directory), 6 % left free | 06:14:21 write; fired 06:29:47 (the 15-minute hold) | check 1 (volume `storage`, 6.2 % free, one step down at 06:14), check 2 as written measured the container's root (`/usr` 1.2G): the host shell expanded `$STORAGE_ROOT` to nothing; in the container's shell it named `Backups/tmp-export` | fixed with **DukaanAiStorageFull**: resolved 06:32:49 | check 2 runs `du` inside `sh -c '...'` (the same mistake was in **DukaanAiBackupNeverRecorded** check 3, corrected); the page says what the API writes (only under shop ids) and what to do with anything else (move it off the volume); "never delete under `STORAGE_ROOT`" left no fix for a foreign file |
| `DukaanAiStorageFull` | the same export loop writes again, the volume full to the last byte | 06:30:31; fired 06:31:59; a bill photo from Smart Capture answered 507 `STORAGE_FULL` ("Nothing was saved; try again once space has been freed") | 25 s: check 1 (`df`: 100 %), check 2 (the two export files, 06:14 and 06:30, outside any shop); the directory moved off the volume at 06:32:2x | the same bill photo stored (201) at 06:32:24; both storage alerts resolved 06:32:49; **DukaanAiHigh5xxRate** quiet | the fix names moving what does not belong off the volume first |
| `DukaanAiUnhandledErrors` | the same incident (`kind=prisma`) | fired 05:14:33, before the ratio alert | walked with **DukaanAiHigh5xxRate** (the error tracker is not configured on the drill stack: its lines read from the API log) | resolved 05:35:46, 15 min after the fix (the window) | without `SENTRY_DSN` the page now names the log lines; the drift check; the alert clears 15 minutes after the fix, not at it |
| `DukaanAiLedgerPostingFailures` | a client session (root, from the host) locks the five `LedgerAccountBalance` rows of one shop `FOR UPDATE` and stays idle in its transaction; one cashier sale at 05:31:21 | the sale answered 503 `DATABASE_UNAVAILABLE` after 50.2 s (the lock wait timeout), readiness 200; **the alert did not fire**: the failure counter was born at 1 and `increase()` saw nothing; the cashier's Retry (same key) failed at 05:43:15 (counter 1 to 2): fired 05:43:50 | 46 s: check 1 (`source=SALE` by Prometheus), check 2 (the page's query for the posting service's own lines: none exist; the billing warning and the filter's `Database unavailable` line), check 3 (`sys.innodb_lock_waits`: `blocking_pid 529`, open 13 min, `KILL 529`), then `KILL 529` at 05:44:36 | the waiting Retry completed at once (201, 20.1 s); test sale 201; reconciliation CLEAN (4 sales, net 100.00); resolved 10 min after the last failure | the first failure of each kind never paged: every alerted counter is now created at 0 at start-up (`zeroSeries`, guarded by `alerted-series.spec.ts` and a promtool test); the counts in the descriptions are rounded (`2.051282051282051 ledger posting(s)`); checks 1 and 2 rewritten (Prometheus for the source, the real log lines, the 503-with-readiness-200 signature); check 3 uses `sys.innodb_lock_waits` (`performance_schema.data_lock_waits` gives thread ids, not the connection ids `KILL` takes; an idle holder is `Sleep` with no query in the processlist); section 4 has the administrator SQL prompt |
| `DukaanAiCheckoutSlow` | shop fa526502: an integration session locks its smoke product row 900 ms of every second while its cashier sells one every 2 s (shop 03d6e02a selling normally beside it) | 06:20:08 start; fired 06:34:04 | 112 s: check 1 (the checkout access lines by user: fa526502 p50 466 ms / p95 945 ms, 03d6e02a p95 132 ms), check 2: one look at `sys.innodb_lock_waits` showed nothing (waits under a second); ten samples in 3 s caught `Product` waited on by an API connection, `blocking_pid` 1256 (root from the host, `Sleep` between its holds), `Innodb_row_lock_waits` rising with every sale (avg 786 ms); `KILL 1256` at 06:35:56 | the shop's checkouts quick at once; resolved when the 10-minute window emptied | check 1 used a `shopId` the access line does not carry: by `userId`, then their shop; check 2 samples the lock view and reads the InnoDB row-lock counters; the fix stops what runs the session (it reconnects otherwise); the page says one slow checkout in a quiet hour is the whole p95 (in the ledger walk it held this alert pending for 10 minutes) |
| `DukaanAiOutboxLag` | `system-events` paused by hand (as a Redis maintenance or an operator leaves it) and left paused while a cashier made 1,500 sales (06:12:35 to 06:37:36) | 06:12:35 pause; fired 06:27:59 (5 minutes of age + the 10-minute hold) | 84 s: check 1 (no instance carries `CRON_ENABLED`), check 2 (the rows CLAIMED, then PENDING again with the reaper's `stale claim: no worker finished it`), check 3 (`queue_paused{queue="system-events"}` 1, 2,130 waiting, 0 active; `bull:system-events:meta` `paused` 1); the resume held 40 minutes on purpose so the reaper failed rows (**DukaanAiOutboxFailedRows**), then the page's resume command at 07:08:34 | 11,552 queued jobs (one per row and handover) drained in 2 minutes; every one of the 2,420 rows DONE, the 1,429 the reaper had FAILED included, one idempotency marker per event (9,257 duplicate jobs skipped), no error line; resolved 07:10:32 | the walk the page planned (`CRON_ENABLED=false`) uses a setting no deployment carries, so the queue was paused instead; on the rc3 image a paused queue's jobs did not show at all (see **DukaanAiQueueBacklog**); the paused-queue cause, the resume command and how the backlog drains are on the page, now measured |
| `DukaanAiOutboxFailedRows` | the same paused queue: each row handed over 5 times (`EVENTS_OUTBOX_MAX_RETRIES`), given back by the reaper each time, then FAILED | the first rows FAILED at 06:49; fired 07:04:35 (the 15-minute hold) | about 4 minutes, most of it the page's own errors: check 1 through the route (the shop's newest 100 rows, all `INVOICE_CREATED`, no count); the page's SQL failed (`Unknown column 'eventType'`), corrected: 923 and 236 rows of two shops, all `stale claim: no worker finished it`; check 2 led back to the paused queue | resumed with **DukaanAiOutboxLag**: the FAILED rows ended DONE from their queued jobs without one retry, FAILED 0 at 07:09:20; the route probed on one row (the page's body `{"id"}` 400, `{"eventId"}` 201, again 409 `OUTBOX_EVENT_NOT_FAILED`); resolved 07:09:32 | the SQL (`type`, `processedAt`), the retry body (`eventId`), the stale-claim cause (resume, then retry only what is still FAILED once the queue is empty), the list's 100-row cap with a retry pass, and the operator's reset across shops (the route's own change); both commands run as written at 07:48 on five rows failed on purpose: `3 201` and `ROW_COUNT 2`, every event still handled once |
| `DukaanAiBackupStale` | the `binlog-archiver` service stopped (last archive 06:13:19) | 06:14:11 stop; fired 06:33:34 (15 min objective + the 5-minute hold) | 57 s: check 1 (`db-ops status`: binlog 06:13:19), check 2 (the log ends at the last archive and says nothing; only `dc ps -a` shows `Exited (137)`), then the service started and `binlog-archive --flush` run by hand at 06:34:31 | resolved 06:35:02 | check 2 starts with `dc ps -a` (a stopped job leaves no line in its log); the stop itself was a finding: the loop is PID 1 and ignored SIGTERM, so every stop waited 10 s and killed it (exit 137; the backup-agent sidecar would hold every pod's shutdown for its whole grace period): both loops trap TERM, a stop now takes 0.5 s and exits 0 |
| `DukaanAiBackupNeverRecorded` | the off-site job's stamp (`offsite.last-success`) removed from the status directory | 06:14:12; fired 06:44:35 (the 30-minute hold) | 50 s: check 1 (`db-ops status`: no `offsite` line), check 2 (scheduled? on this stack only the binlog archiver is: the nightly set runs from the `backup-agent` of the production compose file or host cron, so the off-site push had run once, at the stack's start), check 3 (the API reads `BACKUP_STATUS_DIR`: three stamps, no `offsite`); `db-ops offsite push` by hand at 06:45:00 | resolved 06:45:31 | check 3's command ran `ls` on a variable the host shell expanded (corrected with **DukaanAiStorageLow**'s) |
| `DukaanAiReconciliationDrift` | shop fa526502: a count "corrected" by hand on the database (`UPDATE InventoryItem SET onHand = onHand + 5`), then the owner's `POST /reconciliation/run` | 06:16:00 write and run (DRIFT, 2 stock drifts: onHand 13 against a ledger of 8, currentStock 8 against Σ onHand 13); fired 06:16:29 | 68 s: check 1 (`ReconciliationRun`: the shop's newest run DRIFT), check 2 (the two drifts), check 3: no audit row and no stock-ledger entry for the change, and the binary log (`mysqlbinlog` through `db-ops`) shows session 1197 at 06:16:00 updating that one `InventoryItem` row and nothing else; the write undone exactly (guarded on the drifted value), then the shelf count the owner confirmed (13) recorded in the application (`MANUAL_COUNT` +5 with a note naming the run) | run CLEAN at 06:17:38; resolved 06:17:59 | the page said "never in the database": a write made outside the application cannot be corrected inside it (an adjustment moves the ledger too and the drift stays), so the page now says to undo exactly that write, then record any real difference in the application; check 3 names the binary log as the place that shows such a write |
| `DukaanAiReconciliationStale` | every `ReconciliationRun` made 27 hours older on the database (the nightly run has not happened since yesterday's) | 06:40:01; fired 07:10:32 (26 hours + the 30-minute hold) | check 1 (no instance carries `CRON_ENABLED`; `CRON_RECONCILIATION` unset: 01:30 UTC), check 3 (`TTL cron:reconciliation` -2: no lock held); check 2 as written read `dc logs --since 30h`, which holds only the running container (recreated at 06:09): a deploy after 01:30 takes the night's lines away, Loki keeps them; the fix as written could not run: `npm run reconcile` in the API container answered `sh: ts-node: not found` (the image carries `dist`, no `scripts/`), and the owner's route needs every shop owner's password | the commands compiled into the image and the API redeployed with them; `dc exec api node dist/cli/reconcile --all-shops` at 07:30:54: 5 shops CLEAN, exit 0; resolved 07:31:04; the walk day itself (`--date 2026-10-08`): 5 clean, with 1,503 and 901 sales through every injected incident | the operator commands ship in the image (`node dist/cli/reconcile`, `--all-shops` for a missed night; guarded by the boot-regression spec); `docs/SECRETS.md`'s session revocation had the same defect (`dist/cli/revoke-all-sessions`: dry run in the container, exit 0); check 2 reads Loki; the redeploy resolved the firing alert for one scrape and started its 30 minutes again: every alert read from an API gauge now keeps firing 2 minutes (`keep_firing_for`, promtool case; live: an API restart during **DukaanAiStorageFull** left it firing, the fix resolved it 2 minutes later) |
| `DukaanAiQueueBacklog` | the same incident as **DukaanAiOutboxLag**: `system-events` paused while 1,500 sales were made (06:12:35 to 06:37:36) | waiting over 1,000 from 06:23:49 (the paused jobs, counted by this walk's image); fired 06:38:46 | 21 s: check 1 (`queue_paused` 1, 4,962 waiting, 0 active), check 2 (no worker line: nothing runs), check 3 (Redis 10 MB); the resume held with the outbox incident | see **DukaanAiOutboxLag** | on the rc3 image this alert could not fire for a paused queue: BullMQ keeps a paused queue's jobs in its `paused` list, which `getJobCounts` reports apart from `waiting`, and the collector read only `waiting` (0); paused jobs now count as waiting and `queue_paused` says why (unit test, and probed on real Redis); check 1 and the fix name the pause and the resume command |
| `DukaanAiQueueFailedJobs` | a shelf photo uploaded from a phone, cut off in transit (a JPEG header and half the data): the upload's signature check passes, the thumbnail job fails three times | 06:19:2x upload; fired 06:49:44 (the 30-minute hold) | 25 s: check 1 (the page's command: job `generate-thumbnails`, `VipsJpeg: premature end of JPEG image`, 3 attempts, the asset and shop), check 2 (a corrupt file: no retry can succeed); the job removed at 06:50:1x | the shop's second upload processed (thumbnails generated); resolved 06:50:36 | the fix gives the exact retry / remove commands and the corrupt-photo case; found: a broken media asset cannot be removed (no route), entered for the defect log |
| `DukaanAiCredentialFlood` | wrong-password logins for ever-new unknown accounts, one a second: first straight to the API with a forged forwarded address (06:14:35), then, from 06:23, from a host of its own on the drill network through the edge, as an attacker comes | fired 06:25:40 | 10 s: check 1 (the 429s of the last 5 minutes by address: one, 172.18.0.8), check 2 (the `AuthService` lines: unknown accounts only, nobody's account at risk), check 3 (not a shop's address); block at the edge at 06:27:33 (`EDGE_BLOCKED_IPS=172.18.0.8`, `dc up -d edge`) | the blocked host answered 403 by the edge, another host 200, nothing from the address in the API's log; resolved 06:32:00 (the 5-minute rate window) | the page said "block at the edge" with no way to do it but editing the committed Caddyfile on the server: `EDGE_BLOCKED_IPS` (a `client_ip` matcher answering 403, default `0.0.0.0/32`, validated by `caddy validate`) and the Kubernetes annotation; the login lines carried neither the address nor the request's correlation id, so a flood's accounts could not be grouped by address: `validateUser` now logs both as fields (the local strategy passes the request) |
| `DukaanAiEmailDeliveryFailing` | the API redeployed (image with this walk's fixes) with `SMTP_URL` carrying the relay password from before the provider rotated it; a shop owner asks for a reset link | 06:02:33 deploy; 06:02:44 the relay answers 535; **no alert**: the failure came 11 s after the start, before the new process's first scrape, and the previous process (rc3) had no such series; the owner asks again at 06:08:56: fired 06:09:06 | 16 s: check 1 (the API log line: `EAUTH 535 5.7.8 Authentication credentials invalid`), check 2 (the provider's console: the password was rotated), then the rotated password deployed | an invitation to the on-call's own address reached the relay at 06:09:31; resolved 30 min after the last failure | first live proof of the zero series (the second failure paged at once); the page names the log command; the first-start gap is recorded in section 7 (a failure before the first scrape of the first process that exposes the series) |
| `DukaanAiEndpointDown` | `dc stop web` (the login-page probe fails, edge and internal) | 04:48:00 inject; fired 04:50:31 (2 min 31 s, edge probe first) | 10 s: check 1 (probe `blackbox-login`, edge), check 3 (`dc ps web`: exited), then `dc restart web` | resolved 04:51:47 (one probe interval after the fix); login page 200 | none: the page led straight to the cause |
| `DukaanAiCertificateExpiring` | the edge's certificate (a file, `EDGE_TLS_LINE`) replaced by one expiring in 2 days 6 hours (`drill-stack.sh tls near`) | 06:11; fired 07:12:22 (the 1-hour hold) | 2 minutes: check 1 (the dates and the issuer through the edge: Oct 10 13:34 UTC, the drill CA), check 2 found no ACME line, only `skipping automatic certificate management because one or more matching certificates are already loaded`: a file, which nothing renews; the renewed file installed and the edge reloaded in place at 07:14:26 | the new dates (Jan 5 2027); resolved 07:14:53 and 07:15:23, at the next certificate probe | the page assumed automatic renewal: check 2 and the fix now cover a file certificate (replace the files, `caddy reload --force`; a restart cuts the requests in flight), and Verify says the next probe, not an hour |
| `DukaanAiCertificateExpired` | the file certificate replaced by one that expired on Oct 6 (`tls expired`) | 07:15:42; fired 07:16:23 (at once, the next probe) | 36 s to the cause: what a client sees (`curl: (60) ... certificate has expired`), the dates, the edge log (a file certificate); the fix held until **DukaanAiEndpointDown** of both addresses had fired (07:18:33) to see it held back: suppressed, inhibited, one page; renewed file installed and reloaded at 07:18:52 | HTTPS 200 at once; EndpointDown resolved 07:19:53 without ever paging; resolved 07:21:53 (the 2-minute hold) | the fallback as written (`/etc/caddy/certs`) names a path no compose file mounts: a file now goes on the edge's persistent `/data` volume (`dc cp`), one certificate for both names; the renewed-file path (replace and reload) is next to renewal by restart |

What the walks found beyond the pages' own commands (wrong columns, a
`dc run` that started the stopped database, variables the host shell
expanded, fields and bodies that do not exist), each fixed and tested:

- The first failure of a kind never paged: a labelled counter has no
  series until its first event, which starts it at 1, and `increase()`
  sees no change. Every counter an alert reads is now created at 0 at
  start-up (`zeroSeries`, `alerted-series.spec.ts`, a promtool case).
  What remains: a failure before the first scrape of the first process
  that exports the series (once, at the deploy that introduces it).
- A paused queue's jobs were invisible: BullMQ keeps them apart from
  `waiting`. They count as waiting now, and `queue_paused` says why.
- The error and login log lines carried their request's correlation id
  only inside their text, and the login lines no client address: both are
  fields now, so Loki groups an incident and a flood by them.
- Blocking an address at the edge meant editing the committed Caddyfile:
  `EDGE_BLOCKED_IPS`.
- The backup loops ignored SIGTERM (PID 1, no trap): every stop waited 10
  seconds and killed them; they exit at once now.
- The operator commands the runbooks and `docs/SECRETS.md` name did not
  exist in the image: `node dist/cli/reconcile` (with `--all-shops`) and
  `node dist/cli/revoke-all-sessions` ship with the API.
- A deploy resolved a firing alert read from an API gauge for one failed
  scrape and restarted its hold time: those alerts keep firing 2 minutes.
- Not fixed here (`docs/PILOT.md`, "Found walking the runbooks"): a broken
  media asset cannot be removed, no route deletes one.

After the walks, every shop of the stack reconciled its business day CLEAN
(1,503 and 901 sales in the two busiest shops, through every incident
above), and no sale was lost or written twice.

The staging runs of `docs/DRILLS.md` §6 repeat these walks with the
on-call's phone and the real paging channel; their dates go into the
**Walked** line of each page.
