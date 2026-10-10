# Observability

Roadmap 7.6: what the API tells an operator, where it comes from, and what to
do when an alert fires. Everything here is API-side; the web app has no
telemetry of its own (its errors reach the API as requests, and the browser
console on a page failure).

## Logs

The API prints one JSON object per line (`CorrelationLogger`,
`apps/api/src/common/logger/correlation.logger.ts`) with `message`,
`context`, `level`, `timestamp` and `correlationId`. The correlation id is
the one the request carried in `x-correlation-id` (sanitised; anything
malformed becomes a UUID) and the one the client gets back in every error
envelope, so a user-reported `correlationId` finds every line of that request:

```
docker compose logs api | grep '"correlationId":"3f1c…"'
```

Lines written outside a request (crons, workers) carry `system-job`.
Sensitive keys (`password`, `token`, `authorization`, `cookie`, `secret`,
`payment`, …) are redacted before the line is written.

`LOG_LEVEL` is the most verbose level printed: `fatal`, `error`, `warn`,
`log`, `debug` or `verbose` (`LoggingConfig`). The default is `debug`
outside production and `log` in production, and production refuses to boot
with `debug` or `verbose` (`[Bootstrap FATAL] … logLevel is "debug":
production prints at most the "log" level`). `PRISMA_LOG_QUERIES` is the
separate switch for query logging and stays `false` in production.

Ship the container's stdout to whatever indexes JSON (Loki, CloudWatch,
Elastic); no file is written.

## Metrics

`GET /api/metrics` answers the Prometheus text format (prom-client). The
route needs no login (a scraper has no user) and is exempt from rate
limiting; `METRICS_ENABLED=false` answers 404 and `METRICS_TOKEN` (16+
characters, never a placeholder) makes the scrape require
`Authorization: Bearer <token>` (401 otherwise; the refused scrapes are
counted like any other answer). Keep the API port off the public internet
regardless: the scrape target is the internal address. The reference edge
(`deploy/edge/Caddyfile`) answers 404 for `/api/metrics` and the
Kubernetes Ingress routes it to a Service with no endpoints, so from the
internet the route does not exist (roadmap 9.8); Prometheus reads
`api:3002` on the compose network or `dukaanai-api.dukaanai.svc:3002`
through the NetworkPolicy's monitoring rule.
`deploy/prometheus/prometheus.yml` is the scrape configuration;
`docker compose --profile ops up -d prometheus` runs it against the compose
stack on <http://localhost:9090> (the whole monitoring stack:
`deploy/observability/compose.yml`, included by both compose files).

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` | every answer, guard rejections and 404s included (`httpMetricsMiddleware`, before the routers). `route` is the Express pattern (`/api/products/:id`), or `unmatched` for a path no route owns, so scanner noise is one series. |
| `http_request_duration_seconds` | histogram | `method`, `route` | request latency; p95 per route with `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))`. |
| `checkout_duration_seconds` | histogram | `outcome` = `completed` / `replayed` / `rejected` | `BillingService.createInvoice` end to end, the one-transaction sale (contract §3). The load baseline (`docs/LOAD_TEST_BASELINE.md`) is p95 under 500 ms at 3x peak. |
| `ledger_posting_failures_total` | counter | `source` (SALE, RETURN, GRN, …) | a `LedgerPostingService.post` that threw: unbalanced entries, a lock or write failure. The surrounding transaction rolled back. |
| `outbox_oldest_pending_age_seconds` | gauge | | seconds since the oldest PENDING / CLAIMED outbox row was created, 0 when nothing waits. Refreshed on each scrape from MySQL. |
| `outbox_rows` | gauge | `status` | outbox rows by status (PENDING, CLAIMED, PROCESSING, DONE, FAILED). |
| `queue_jobs` | gauge | `queue`, `state` | BullMQ job counts per queue (waiting, active, delayed, failed) from the queue clients of this process. `waiting` includes the jobs of a paused queue (BullMQ keeps them in its `paused` list; until roadmap 9.22 a paused queue read 0 waiting). |
| `queue_paused` | gauge | `queue` | 1 while the queue is paused (by hand: BullMQ keeps the pause in Redis, so a restart does not lift it), else 0. |
| `retention_rows_purged_total` | counter | `table` | rows removed by the retention sweep (roadmap 7.8). |
| `reconciliation_runs_total` | counter | `status` = `clean` / `drift` / `failed` | financial reconciliation runs (roadmap 9.5): the nightly cron, `POST /reconciliation/run` and the CLI alike. |
| `reconciliation_drift_total` | counter | `check` = `documents` / `postings` / `tenders` / `dashboard` / `shifts` / `stock` / `ledger` | drifts found by reconciliation runs, by check. |
| `reconciliation_shops_with_drift` | gauge | | shops whose newest reconciliation run ended in DRIFT or FAILED, read from `ReconciliationRun` on every scrape (a restart or another instance shows the same figure). |
| `reconciliation_last_run_timestamp_seconds` | gauge | | Unix time the most recent reconciliation run finished, across every shop; 0 until one has run (an unlabelled prom-client gauge always has a sample, so the stale alert ignores 0). |
| `dependency_up` | gauge | `dependency` = `database` / `redis` | whether this instance reached the dependency on the last scrape (`SELECT 1`, Redis `PING`, 2 s each; roadmap 9.18). Probed first on every scrape: a source that needs a dependency that is down is skipped, and every source has a 2.5 s budget, so the scrape answers through a database or Redis outage instead of reading as "API down". |
| `email_messages_total` | counter | `purpose` = `invitation` / `password_reset` / `password_changed`, `outcome` = `sent` / `failed` / `logged` | outbound mail by what it was for and what the relay did with it (roadmap 9.19). `failed` is a relay refusal or an unreachable relay; `logged` is a server without `SMTP_URL` writing the message to its log (development only: production answers 503 instead). |
| `storage_volume_free_bytes`, `storage_volume_size_bytes` | gauge | `volume` = `storage` / `uploads` | free (what the API may use) and total bytes of the volume under `STORAGE_ROOT` and under `UPLOAD_TEMP_DIR`, from `statfs` on every scrape (roadmap 9.18). |
- `backup_last_success_timestamp_seconds{kind}`: Unix time of the last successful backup job (`dump`, `binlog`, `documents`, `offsite`), read on every scrape from the `<kind>.last-success` files in `BACKUP_STATUS_DIR` (roadmap 9.4; written by `scripts/db/lib.sh` `record_success`). A kind whose file disappears loses its series.
| `errors_tracked_total` | counter | `kind` = `unhandled` / `prisma` / `job` / `startup` | errors handed to error tracking, counted whether or not a DSN is set. |
| `build_info` | gauge | `release` | always 1, labelled with the release the process runs (`APP_RELEASE`, baked into release images; `unknown` when unset; roadmap 9.21): which version answers, per instance, during and after a deploy. |
| `dukaanai_process_*`, `dukaanai_nodejs_*` | | | prom-client's default process and event-loop metrics. |

The counters an alert reads with `increase()` (`ledger_posting_failures_total`,
`email_messages_total`, `errors_tracked_total`) exist at 0 for every label
value from start-up (`zeroSeries` in `metrics.ts`, roadmap 9.22): a series
born at 1 by its first event shows no `increase()`, and walking
`DukaanAiLedgerPostingFailures` met a refused sale that paged nobody.
`alerted-series.spec.ts` fails when an alerted counter lacks its zero
series. What remains: a failure before Prometheus first scrapes the first
process that exposes the series (once, right after this change is
deployed), or a failure count right after a restart that equals the
previous process's count; the next failure pages.

Every series carries `service="dukaanai-api"`. Counters and histograms are
per process: with several API instances, `sum(...)` across them; the gauges
read shared state (database, Redis) and are the same from every instance,
so take `max(...)`.

Labels stay low-cardinality on purpose: route patterns, status codes, queue
names, source types. Never add an id, a shop or a user as a label; those go
on the log line and on the tracked error.

## Error tracking

`ErrorTracking` (`apps/api/src/common/observability/error-tracking.ts`) is a
facade over `@sentry/node` that is a no-op until `SENTRY_DSN` is set (a
placeholder DSN refuses to boot, so a template value cannot silently
disable it). It is initialised in `main.ts` before anything else can fail
and captures:

- every error the `GlobalExceptionFilter` answers as 500: an unhandled
  exception, an `InternalServerErrorException` thrown on purpose, and a
  Prisma error with no mapped status (`kind` = `unhandled` / `prisma`);
- a failed bootstrap (`kind` = `startup`, flushed before `exit(1)`).

Expected 4xx/5xx answers (validation, 404, `OCR_NOT_CONFIGURED` 503, the
draining 503) are not errors and are not sent; they are visible in
`http_requests_total`. Each event is tagged with `correlationId`, `shopId`,
`route`, `method`, `statusCode` and `kind`, and the user id when a request
had one, so an issue joins the JSON log line that carries the same id.
Request bodies, headers, cookies and query strings are never sent
(`dataCollection` is switched off). `APP_RELEASE` (baked into release
images: the version tag or `sha-<7>`, roadmap 9.21; the same value is
`build_info{release}` and the `release` of `GET /api/health`) and
`SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`) label every event; `SENTRY_TRACES_SAMPLE_RATE` stays 0 unless
performance tracing is wanted (0..1).

## Alerts

`deploy/prometheus/alerts.yml` (validated with `promtool check rules`) holds
the rules; `severity` is `critical` for what needs a person now and
`warning` for the rest. Every alert carries a `runbook_url` to its page in
`docs/RUNBOOKS.md` (roadmap 9.22: what it means, the first checks, the fix,
the verification, what to tell the shops), which also holds the incident
roles, the shop-owner message templates and the post-incident review. The
table below is the one-line summary:

| Alert | Fires when | First look |
|---|---|---|
| `DukaanAiApiDown` | no scrape for 2 min | `GET /api/health/ready` (503 `draining` / `unavailable` with `checks`), container logs for `[Bootstrap FATAL]`. |
| `DukaanAiHigh5xxRate` | > 1 % of answers are 5xx (ratio over 2 min, with traffic, the `/api/health*` routes left out) for 5 min in a row | the access log (`"event":"http"`, `"status":500`) gives the route and the correlation id, the `GlobalExceptionFilter` line with that id the cause (`Prisma error P2022`: a column the code reads is missing, often a change made by hand: `migrate diff --exit-code`, `migrate status` does not see it); the error tracker has the stack. 503 `DATABASE_UNAVAILABLE` means the database is away (`DukaanAiDependencyDown` names it), 507 `STORAGE_FULL` a full volume. The ratio window was 5 min until the MySQL drill of roadmap 9.18 showed it paging 4.5 minutes after a 60-second outage had ended, and the readiness route counted until the Redis drill showed its probes' 503s paging "5xx" while every sale succeeded; outages are the probes' and `DukaanAiDependencyDown`'s job. |
| `DukaanAiDependencyDown` | `dependency_up` is 0 on every instance for 2 min | `database`: sign-in, sales and every page answer 503 `DATABASE_UNAVAILABLE` (retry-safe, the POS offers Retry); check the MySQL host or the provider's status page and the connection limit. `redis`: sales continue (stock keys, cache and rate-limit counters fall back in-process) but queued work waits; check the Redis host. While it fires, `DukaanAiEndpointDown` on `/api/health/ready` is held back (one page that names the cause), and it keeps firing 2 min after the dependency is back (`keep_firing_for`) so the probe recovers first: the Redis drill saw the edge probe page 50 s after this alert had resolved. |
| `DukaanAiStorageLow` | a volume under 10 % free for 15 min (warning) | `storage_volume_free_bytes` by `volume`; grow the disk or clear what is reproducible (`imports/`, `exports/`, `tmp/` under uploads). |
| `DukaanAiStorageFull` | a volume under 2 % free for 1 min (critical) | bill photos, invoice PDFs and statements answer 507 `STORAGE_FULL` (nothing partial is kept, so a repeat succeeds once space is back); sales continue. Free or grow the volume now. |
| `DukaanAiUnhandledErrors` | > 5 tracked errors in 15 min | same as above when the ratio alert is quiet (low traffic). |
| `DukaanAiLedgerPostingFailures` | any posting threw in 10 min | `Unbalanced ledger posting` in the logs is a code defect (money math changed outside `@dukaanai/invoice-math`); a database error means the sale / return / receipt rolled back and the client saw an error. The ledger stayed consistent: nothing was written. |
| `DukaanAiCheckoutSlow` | completed-checkout p95 > 500 ms for 10 min | MySQL lock waits (one shop bills serially: shift, number sequence and product rows are locked in order), the MySQL slow query log, Redis latency, CPU of the instance. Re-run the load test after a fix (`apps/api/load`). |
| `DukaanAiOutboxLag` | oldest waiting outbox row > 5 min for 10 min | the state of the oldest waiting rows: PENDING means nothing relays them (the relays run every 1 to 5 s on every instance with `CRON_ENABLED`, which no deployment sets, so it is on), CLAIMED means they were handed to a queue nobody drains: `queue_paused` (a pause survives restarts) or `queue_jobs{state="waiting"}` against `active`; then Redis (`docs/RUNBOOKS.md`). |
| `DukaanAiOutboxFailedRows` | FAILED rows for 15 min | the error of each (`docs/RUNBOOKS.md` has the query across shops; a manager sees the shop's newest 100 at `GET /sales/events?status=FAILED`). `stale claim: no worker finished it` means nobody worked the queue: resume it and the queued jobs end the rows DONE on their own. Otherwise fix the cause (a webhook target, a listener bug), then `POST /sales/events/retry {"eventId": ...}` per row. |
| `DukaanAiQueueBacklog` | > 1000 waiting jobs on a queue for 15 min | the queue is paused (`queue_paused` is 1; a pause survives restarts), or its worker is not keeping up (one API replica until the documents move to object storage, so find the slow job) or is crashing on every job (its errors are in the logs). |
| `DukaanAiQueueFailedJobs` | failed jobs on a queue for 30 min | the failed set in Redis holds the job data and the last error; outbox-backed jobs also marked their row FAILED (above). |
| `DukaanAiBackupStale` | a backup kind older than its objective: `binlog` 15 min, `dump` / `documents` / `offsite` 26 h, for 5 min | `db-ops status` shows every job's last success; run the late job by hand (`db-ops backup`, `binlog-archive --flush`, `documents-backup`, `offsite push`) and read its error: a full volume, a lost privilege, an unreachable remote, a wrong key. The recovery point grows while it stays red (`docs/DATA_SAFETY.md`). |
| `DukaanAiBackupNeverRecorded` | no `backup_last_success_timestamp_seconds` series for a kind, for 30 min | the job is not scheduled (cron, `binlog-archiver` service), the API cannot read `BACKUP_STATUS_DIR` (the `db-backups` volume mounted read-only), or the job writes its stamps elsewhere (`BACKUP_STATUS_DIR` on the job side). |
| `DukaanAiEndpointDown` | a blackbox probe (readiness route or login page, inner or public address) has failed for 2 min | `GET /api/health/ready` names the failing dependency; then the edge (`docker compose logs edge`) and DNS. Held back while `DukaanAiApiDown`, `DukaanAiDependencyDown` (readiness probes) or `DukaanAiCertificateExpired` (same address) fires. A certificate that does not verify for another reason (wrong name, incomplete chain) fails it too: `curl -vI` the address. |
| `DukaanAiCertificateExpiring` | the certificate of a public address expires in under 14 days, for 1 h (warning) | renewal has not happened: Caddy needs ports 80/443 and the DNS names right (`docker compose logs edge`), cert-manager the `Certificate` resource. A certificate installed as a file (`EDGE_TLS_LINE` naming files; the edge logs `skipping automatic certificate management`) is never renewed by the edge: install the renewed files and reload it in place (`caddy reload --force`). It ends when the certificate expires, because the page below starts. |
| `DukaanAiCertificateExpired` | the certificate of a public address has expired (at once, critical; keeps firing 2 min after a renewal is read, so the address's probes recover while it still holds them back) | every browser refuses the address. Renew now (restart the edge once ports and DNS are right, or `kubectl describe certificate`; a file certificate: install the renewed files, `caddy reload --force`). Read by job `blackbox-tls`, which reads the certificate whether or not it verifies: on the verified probes an expired certificate made the warning resolve and an unexplained `DukaanAiEndpointDown` page two minutes later (the certificate drill of roadmap 9.18). |
| `DukaanAiCredentialFlood` | the credential routes (`/api/auth/*`) answered more than one 429 every 10 s for 10 min (warning) | the limits are holding (`docs/PRODUCTION_LIMITS.md`); the access log (`event=http`, `status=429`, `route=/api/auth/...`) names the source addresses; block a persistent source at the edge, and check the targeted account's owner is not locked out. |
| `DukaanAiEmailDeliveryFailing` | a mail of a purpose was not accepted by the relay in the last 30 min (at once, warning) | the API log line `was not accepted by the relay` carries the relay's reply (`535` credentials, `550`/`553` sender or recipient refused, `ECONNECTION` relay down). An invitation answered the owner 502 `INVITATION_EMAIL_FAILED` and kept nothing, so the owner can repeat it once the relay works; a reset link was voided while the user was told it was sent, so ask them to request it again. Check `SMTP_URL`, the provider's quota and the domain of `EMAIL_FROM` (SPF/DKIM), then send an invitation to yourself. |
| `DukaanAiReconciliationDrift` | a shop's newest reconciliation run ended in DRIFT or FAILED (at once) | `GET /reconciliation/latest` as that shop's owner, or `node dist/cli/reconcile --shop <id> --date <day>` in the API container (`npm run reconcile` from a checkout): every drift names the check, the document or row and the two figures that disagree (`docs/POS_BILLING_CONTRACT.md` §11). A FAILED run carries the error. Nothing is corrected by the job; find the write that produced the row and fix the data with a recorded adjustment. A change made outside the application (no audit row, no ledger entry; the binary log shows it) is undone exactly instead, since an adjustment would move the ledger too. |
| `DukaanAiReconciliationStale` | no reconciliation run finished anywhere for 26 h, for 30 min (a stack that has never reconciled exports 0 and does not fire) | the `Reconciliation` schedule (`CRON_RECONCILIATION`; `CRON_ENABLED` is on unless an instance was given it), the `cron:reconciliation` lock (a dead pod's lock expires after 30 min), the `Reconciliation` lines in the logs (Loki: `docker compose logs` holds only the running container, and a deploy since 01:30 erased the night's lines there); run the missed night with `node dist/cli/reconcile --all-shops` in the API container (each shop's previous business day; `--date` names an older one), or one shop with `POST /reconciliation/run`. |

## Alert delivery

Roadmap 9.10. Prometheus sends every firing rule to Alertmanager
(`deploy/observability/compose.yml`, service `alertmanager`;
`deploy/alertmanager/alertmanager.yml.tmpl` rendered by `render.sh` from
the `ALERT_*` variables of `.env`):

| Severity | Who | How | Repeat |
|---|---|---|---|
| `critical` (API down, 5xx wave, dependency down, full volume, expired certificate, ledger failure, stale backup, drift, endpoint down) | the on-call AND the team | PagerDuty when `ALERT_PAGERDUTY_ROUTING_KEY` is set (a page), else Slack + email at once | hourly until resolved |
| `warning` (everything else) | the team | Slack and/or email | every 4 h; held between 22:00 and 08:00 and on Sunday in `ALERT_TIMEZONE`, delivered when the window ends |

While `DukaanAiApiDown` fires every warning is inhibited (one page, not a
dozen), and while `DukaanAiDependencyDown` fires the readiness probe's
`DukaanAiEndpointDown` is held back (the Redis drill of roadmap 9.18 paged
three times for one cause before; the login-page probe is never held back
for a dependency). While `DukaanAiCertificateExpired` fires for an address,
the `DukaanAiEndpointDown` of the same address is held back: the page names
the expired certificate, not a failing probe. Each channel is on when its variable is set (`ALERT_EMAIL_TO` with
`ALERT_SMTP_*`, `ALERT_SLACK_WEBHOOK_URL`, `ALERT_PAGERDUTY_ROUTING_KEY`);
with none set the service starts, logs that alerts reach nobody, and the
compose smoke still proves the routing. Validate a change with
`sh deploy/alertmanager/render.sh --out /tmp/am.yml --secrets /tmp/s &&
amtool check-config /tmp/am.yml` and read the routing with
`amtool config routes test --config.file /tmp/am.yml severity=critical`
(CI does both, in the `prom/alertmanager` image).

### On-call

The rota is kept where the pager is (the PagerDuty schedule, or this table
when Slack + email are the page):

| Week of | Primary | Phone | Backup |
|---|---|---|---|
| (filled in by the owner) | | | |

Expectations: a critical page is acknowledged within 15 minutes, day and
night; a warning is looked at the next working morning. The page of every
alert is in `docs/RUNBOOKS.md` (linked from the notification), with the
incident roles and the messages to the shops.

### Test the delivery (gate of row 9.10)

With the stack up and `ALERT_*` set, fire a synthetic critical alert and
confirm it reaches the on-call phone:

```
curl -fsS -X POST -H 'content-type: application/json' http://localhost:9093/api/v2/alerts \
  -d '[{"labels":{"alertname":"DukaanAiDeliveryTest","severity":"critical","job":"manual"},"annotations":{"summary":"delivery test: reply in the channel when received"}}]'
```

Alertmanager lists it under `/api/v2/alerts` with receivers `oncall` and
`team`; the page (or the Slack message and the mail) must arrive within
`group_wait` (30 s). Record the date, who received it and on which channel
in `docs/STAGING.md`. Resolve it with the same POST and `"endsAt"` in the
past, or let it expire (`resolve_timeout`, 5 min).

## Dashboards

Grafana (`docker compose --profile ops up -d grafana`,
<http://localhost:3001>, admin / `GRAFANA_ADMIN_PASSWORD`) provisions two
dashboards from `deploy/grafana/dashboards` (folder "DukaanAI", read-only in
the UI: edit the JSON in the repository):

- **DukaanAI operations** (`dukaanai-ops`): API up, 5xx ratio, checkout p95,
  outbox lag and failing probes at the top; then checkout latency
  percentiles and checkouts per minute by outcome, requests per second by
  status class, 5xx per route, latency p95 per route, tracked errors;
  outbox rows by status and queue depth by queue and state; ledger posting
  failures, reconciliation drift and age, backup age by kind, retention
  purges; the uptime probes. Every threshold matches the alert it mirrors.
- **DukaanAI logs** (`dukaanai-logs`): the log search below.

`apps/api/src/common/observability/dashboards.spec.ts` fails the unit suite
when a panel or an alert names a metric the API does not register.

## Log search

Every container's stdout is shipped to Loki by Alloy through the Docker
socket (`deploy/alloy/config.alloy`, `deploy/loki/loki.yml`; 31 days,
`docker compose --profile ops up -d loki alloy`), labelled `service`
(the compose service: `api`, `web`, `edge`, ...), `project` and
`container`. The API prints one JSON line per entry
(`{"level","pid","timestamp","message":{...,"correlationId"},"context"}`)
and, since roadmap 9.10, one access line per answer
(`context: HttpAccess`, `message.event: http`, method, path, route pattern,
status, duration, client address, correlation id; the probes and the scrape
are silent), so a correlation id a client quoted (every API answer echoes
`x-correlation-id`) always finds its request, guard rejections included.

The saved query is the "DukaanAI logs" dashboard: type the id into the
`correlationId` box. Its panels run, in LogQL:

```
{service="api"} |~ "<id>"                                      # every line mentioning it
{service="api"} |~ "<id>" | json | message_correlationId="<id>" # the API's parsed lines
{service="api"} | json | level="error"                          # unhandled and Prisma errors
```

(`| json` flattens `message.correlationId` to `message_correlationId`.) The
compose smoke sends a request with a chosen id and finds its access line
in Loki on every CI run; on staging, do the same by hand once and note the
date in `docs/STAGING.md`. A hosted store (Grafana Cloud, Datadog, ...)
replaces `loki.write` in the Alloy file and nothing else.

## Uptime checks

Two layers:

- **Inside the stack**: the blackbox exporter (`deploy/blackbox/blackbox.yml`)
  probes `GET /api/health/ready` (module `http_2xx`: 200, which means
  database and Redis up and not draining) and the login page (module
  `http_login_page`: 200 and the DukaanAI sign-in in the body) every minute
  (`deploy/prometheus/prometheus.yml`, jobs `blackbox-http` and
  `blackbox-login`). The inner targets watch the containers; add the public
  URLs through the edge (commented there) to watch what customers see.
  `DukaanAiEndpointDown` pages after two failed minutes. The job
  `blackbox-tls` (module `tls_certificate`) reads the certificate of each
  public address whether or not it verifies:
  `DukaanAiCertificateExpiring` warns 14 days before a certificate lapses
  and `DukaanAiCertificateExpired` pages the moment it has (all with
  promtool tests). The verified probes lose the certificate when it
  expires, which is why the certificate alerts do not read them.
- **Outside**: a checker on another network, because a dead host cannot
  report itself. Set up, with the owner's account (UptimeRobot, Better
  Stack, Pingdom or the cloud provider's own): an HTTP(S) monitor on
  `https://<API_HOST>/api/health/ready` expecting 200 and the string
  `"status":"ok"`, one on `https://<WEB_HOST>/login` expecting 200 and
  `DukaanAI`, both every minute from at least two regions, alerting the
  same on-call channel (phone/SMS for the API monitor). Gate of row 9.10:
  stop the API on staging (`docker compose -f docker-compose.prod.yml stop
  api`) and confirm the checker reports the outage within two minutes and
  the recovery after `start`; record it in `docs/STAGING.md`.

## Verification

`deploy/prometheus/alerts.test.yml` is a promtool unit test: the two backup
alerts fire on stale and missing series and stay quiet on fresh ones, the
two reconciliation alerts fire on a drifted shop and on a day without a run
(roadmap 9.5), and the uptime alerts fire on a failed probe and a
certificate inside 14 days (roadmap 9.10). CI runs
`promtool test rules` with the rule check in the "Deployment (compose
smoke)" job; locally: `promtool test rules deploy/prometheus/alerts.test.yml`
from `deploy/prometheus`. The same job renders the Alertmanager template in
three configurations and checks the routing with `amtool`, and the compose
smoke brings the whole monitoring stack up: a request is found by its
correlation id in Loki, Prometheus delivers to Alertmanager and a critical
test alert is routed to `oncall` and `team`, Grafana has both data sources
and both dashboards, the two blackbox probes succeed.

- Unit: `apps/api/src/common/observability/*.spec.ts`,
  `src/common/filters/global-exception.filter.spec.ts`,
  `src/config/domains/{logging,monitoring}.config.spec.ts`.
- Integration: `apps/api/test/integration/observability.integration-spec.ts`
  (scrape format, route / status counting, checkout outcomes, outbox and
  queue gauges, the ledger counter, token and disable switches);
  `test/integration/reconciliation.integration-spec.ts` (the reconciliation
  gauges and counters before and after a corrupted row).
- Boot: `test/boot-regression.e2e-spec.ts` refuses `LOG_LEVEL=debug` and a
  placeholder `SENTRY_DSN` in production.
- Rules: `promtool check rules deploy/prometheus/alerts.yml` (CI job
  "Deployment (compose smoke)").
