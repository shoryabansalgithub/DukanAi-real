# POS load test (roadmap 5.8)

`load/pos-peak.yml` drives the three paths a shop hits hardest, at three
times the expected peak, and records the p95 latency and error rate as the
performance baseline (`docs/LOAD_TEST_BASELINE.md`).

| Path | Route | Expected peak | Tested (x3) |
|---|---|---:|---:|
| Checkout | `POST /api/billing/invoice` (cash sale, 1-3 units of a ZERO-GST product) | 5 / s | 15 / s |
| Dashboard | `GET /api/dashboard/summary` | 10 / s | 30 / s |
| Login | `POST /api/auth/login` | 1 / s | 3 / s |

The expected peak is an assumption for one API instance serving a fleet of
small shops (a busy shop bills about one sale every few seconds; the
dashboard polls every few seconds while open). The virtual users are spread
round-robin over `LOAD_SHOPS` shops (default 16): a checkout holds the shop's
shift, number-sequence and product row locks, so one shop bills serially by
design and a single shop cannot absorb the whole fleet peak. Change the
phase `arrivalRate` and the scenario weights together when the target
changes.

## Run

```bash
cd apps/api
LOAD_DATABASE_URL='mysql://user:pass@127.0.0.1:3306/dukaanai_load' \
LOAD_REDIS_URL='redis://127.0.0.1:6379/2' \
load/run.sh
```

- Against an API that is already running (the release candidate image under
  `scripts/certify`, roadmap 9.12): `LOAD_TARGET=http://host:port load/run.sh`
  skips the build and the boot and only needs the target to run with the test
  profile's open rate limits; `load/upload-gate.sh` takes the same variable
  plus `UPLOAD_GATE_CONTAINER` (RSS and the temp directory through
  `docker exec`) or `UPLOAD_GATE_PID` (a local process).
- The database must be migrated (`DATABASE_URL=... npx prisma migrate deploy`)
  and disposable: the run writes `LOAD_SHOPS` shops with an owner, a product,
  stock and a shift each, and about a thousand invoices. Give the URL the
  pool the deployment uses (the baseline ran with
  `?connection_limit=25&pool_timeout=120`, the integration setting).
- `run.sh` builds `dist/`, boots `node dist/main` under `NODE_ENV=test` on
  `LOAD_PORT` (3019) with crons off (so the outbox relay and the nightly
  jobs do not run during the measurement) and the production logging
  profile (`PRISMA_LOG_QUERIES=false`: per-query logging measures the log
  writer, not the API), runs `load/setup.mjs` (per shop, public routes only:
  register, which creates the shop and its OWNER; log in; create and stock
  the product; open a shift; the result lands in the untracked
  `load/.state.json`), runs artillery and prints the table with
  `load/summarize.mjs`, which is the one gate and exits non-zero when it
  fails: **checkout p95 < 500 ms, zero 5xx, zero transport errors (a request
  that times out is a failure), every response 2xx (a stale token answering
  401 is a failure, not a fast success) and the load delivered (users created
  = completed, requests = responses)**. The yml carries no artillery
  `expect`/`ensure` checks: those plugins are not loaded and would be
  ignored silently.
- `NODE_ENV=test` means `.env.test` applies: rate limits effectively off,
  `BILLING_TRANSACTION_MAX_WAIT_MS` and the gateway timeout wide. The
  limiter itself is measured by `load/limits-gate.mjs` (below).
- `upload-gate.sh` is the upload half of the phase gate: it boots the API the
  same way, registers an owner, sends `UPLOAD_GATE_ROUNDS` (12) uploads of
  `UPLOAD_GATE_MB` (300) MB to the media route, samples the API's RSS and
  fails on anything but 413, a temp file left behind, a failed control
  upload, or RSS growth above `UPLOAD_GATE_MAX_GROWTH_MB` (64).
- `ARTILLERY` names the artillery command (`npx artillery@2.0.34` by default;
  artillery is not a dependency of the workspace).
- Reports go to `load/reports/` (untracked): the artillery JSON and the API
  log of each run.

## Production limits gate (roadmap 9.16)

`load/limits-gate.mjs` is the other measurement: not latency but the
**production rate limits** under a real shop's traffic
(`docs/PRODUCTION_LIMITS.md`). Against an API that runs the production
values (the compose stack, staging), it drives `LIMITS_SHOPS` shops x
`LIMITS_TERMINALS` terminals, each shop behind one forwarded address, with
the web's own request mix (page load, dashboard poll every 30 s,
notifications every 60 s, a 5-request sale every 20 s), asserts that no
legitimate request is answered 429 with at least `LIMITS_MIN_HEADROOM`
(1.25x) to spare on every window, reads the limits the API advertises in
`X-RateLimit-Limit-*` and checks they are the production values, then
proves the brute-force limits still hold (429 at attempt
`AUTH_RATE_LIMIT_SHORT_LIMIT + 1` from one address while another address
signs in; 429 at `AUTH_RATE_LIMIT_ACCOUNT_LIMIT + 1` spread over many
addresses). It writes a JSON report and exits non-zero on any failed check.

```bash
cd apps/api
LOAD_TARGET=http://127.0.0.1:3002 node load/limits-gate.mjs
# through an edge that discards X-Forwarded-For (staging):
LOAD_TARGET=https://api.staging.example.com LIMITS_SHOPS=1 LIMITS_FORWARD_FOR=0 node load/limits-gate.mjs
```

`scripts/compose-smoke.sh` runs it on every CI push (step "rate limits
(roadmap 9.16)", switched off with `SMOKE_LIMITS_GATE=0`, which the certify
driver does because its overlay opens the limits for the load profile).

## Simulated business day (roadmap 9.17)

`load/business-day.yml` is the plan and `load/business-day.mjs` runs it
against a deployment that is already up: ten shops, each with an owner, a
manager and three cashiers on their own sessions, billing cash, UPI and
credit sales with GST and discounts, returns, cancellations (manager),
repayments, two stock receipts through the purchase order -> approval ->
goods receipt chain, a mid-day drawer change, dashboard polling, eight
hours of shop time compressed into ninety minutes; Redis is restarted once
and one API instance is killed and started again mid-run through hook
commands, with a checkout burst in flight at the kill. Two browser
sessions per shop (`apps/web/e2e-load/business-day.spec.ts`, an owner on
the dashboard and a cashier on the POS) do the same through the UI from
the state the driver writes. Every document carries an idempotency key and
is retried with the same key on a network failure, as the POS web does.
The gate is read back over HTTP, no database access: zero 5xx answered by
the API, the invoice list of every shop equal to the set the sessions
confirmed (nothing lost, nothing duplicated), returns, cancellations and
repayments accounted for, the keys in flight at the kill complete or
absent, and `POST /reconciliation/run` CLEAN for every shop and business
date. The report is `load/reports/business-day-<stamp>.{json,md}` with an
`.attempts.jsonl` log of every request; `docs/BUSINESS_DAY.md` is the
record.

```bash
cd apps/api
# this machine: a dedicated Redis, two API instances on one disposable database, the web with real auth
BUSINESS_DAY_DATABASE_URL='mysql://user:pass@127.0.0.1:3306/dukaanai_day' npm run load:business-day
# a shorter rehearsal: BUSINESS_DAY_MINUTES=10 BUSINESS_DAY_SHOPS=3 BUSINESS_DAY_UI_SHOPS=1
# staging (already running): the driver alone, with that stack's hook commands
BUSINESS_DAY_TARGETS=https://api.staging.example.com BUSINESS_DAY_DATABASE_URL=... BUSINESS_DAY_WEB_URL=https://app.staging.example.com \
BUSINESS_DAY_CHAOS_REDIS_RESTART='ssh staging docker compose -f docker-compose.prod.yml restart redis' \
BUSINESS_DAY_CHAOS_API_KILL='ssh staging docker compose -f docker-compose.prod.yml kill api' \
BUSINESS_DAY_CHAOS_API_START='ssh staging docker compose -f docker-compose.prod.yml start api' \
node load/business-day.mjs
# and, in parallel, the browser sessions:
cd ../web && BUSINESS_DAY_STATE_FILE=../api/load/.business-day.state.json BUSINESS_DAY_WEB_URL=https://app.staging.example.com npm run test:business-day
```

- The driver needs `BUSINESS_DAY_DATABASE_URL`: the manager and the
  cashiers are seeded directly (a bcrypt row each), because the only route
  that creates a user sends an invitation by email; everything else goes
  through the public routes. Give it a disposable database: the run writes
  shops, staff, products, stock and thousands of documents.
- `business-day.sh` needs `redis-server`, `redis-cli`, `curl` and a built
  `dist/` (`BUSINESS_DAY_SKIP_BUILD=1` reuses it); it boots the web with
  `next dev` and real authentication when `BUSINESS_DAY_UI_SHOPS` is not 0.
  The second API instance is the one killed; the browser sessions use the
  first through the web.
- `scripts/certify/certify.sh` runs a shortened day (`CERTIFY_BUSINESS_DAY_MINUTES`,
  6) against the release-candidate stack with compose as the hook runner
  (`kill api` / `start api` / `restart redis`); with one API container the
  kill takes the only instance down and every session waits the outage out
  with the same key (`BUSINESS_DAY_RETRY_SECONDS`).
- Through an edge that discards `X-Forwarded-For`, the whole day comes from
  one address: either allow the generator's address in the edge's
  `trusted_proxies` for the run and set `BUSINESS_DAY_FORWARD_FOR=1` (one
  address per shop, as in production), or size `BUSINESS_DAY_SHOPS` to the
  per-address limits (`docs/PRODUCTION_LIMITS.md`).

Never run either script against a production database or a Redis db index
a running API uses.
