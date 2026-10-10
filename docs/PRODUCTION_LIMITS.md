# Production rate limits and billing authority (roadmap 9.16)

The test profile (`apps/api/.env.test`) opens every rate-limit window so the
suites and the load profile can run from one address. This document is the
record of the **production** values: how they were sized, the measurement
that proves a real shop's peak never trips them, the proof that the
brute-force limits still hold, and the billing authority values the owner
signs off. The gate that re-proves it is `apps/api/load/limits-gate.mjs`; the
reference compose smoke (`scripts/compose-smoke.sh`, CI job "Deployment
(compose smoke)") runs it on every push against an API that carries the
production limits.

## 1. What the limiter sees

- Counters are per client address (`req.ip`), in Redis, over three general
  windows (`RATE_LIMIT_SHORT|MEDIUM|LONG_*`: 10 s, 60 s, 1 h) on every route,
  and the `AUTH_RATE_LIMIT_*` limits instead on the credential routes
  (login, register, refresh, Google sign-in, invitation accept) plus a
  per-account limit keyed by the submitted email (`src/common/throttling`).
- A shop's terminals share one address: the shop's NAT, which the edge
  passes on (`TRUST_PROXY=1`; the web server forwards the browser's address
  on sign-in and refresh, so those count against the same address). The
  limits are therefore sized **per shop**, not per browser.
- The API advertises the active limits on every answer
  (`X-RateLimit-Limit-<name>` headers), which is how the gate checks it is
  measuring the production values and not the open test profile.

## 2. Traffic model of one shop

Taken from the web application's own code (`apps/web/src`): the dashboard
page polls four reads every 30 s (`POLL_INTERVAL_MS`), the navbar reads
notifications every 60 s (`NOTIFICATION_POLL_MS`), and a POS sale is a
product search, a customer search, the checkout, the grid refresh and the
shift banner.

| Per terminal | Requests | Rate |
|---|---:|---:|
| Page load (dashboard x4, notifications, current shift, product grid) | 7 | once |
| Dashboard poll | 4 | every 30 s |
| Notifications poll | 1 | every 60 s |
| Sale (search, customer search, checkout, grid, shift) | 5 | every 20 s at peak |
| Sign-in / token refresh (credential routes) | 1 | once, then every 15 min |

Three terminals at peak: a burst of 36 general requests in the first second
(every terminal loading and billing at once), 72 a minute and about 4,300
an hour; 3 credential hits at sign-in and 12 an hour afterwards.

## 3. Production values and headroom

`SecurityConfig` defaults = `apps/api/.env.production` = what the compose
and Kubernetes deployments run (the API image carries no env file).

| Window | Limit | Busiest shop measured (§4) | Headroom |
|---|---:|---:|---:|
| `RATE_LIMIT_SHORT_LIMIT` (10 s) | 60 | 36 | 1.67x |
| `RATE_LIMIT_MEDIUM_LIMIT` (60 s) | 200 | 82 | 2.44x |
| `RATE_LIMIT_LONG_LIMIT` (1 h) | 10000 | 5,687 extrapolated | 1.76x |
| `AUTH_RATE_LIMIT_SHORT_LIMIT` (10 s) | 5 | 3 | 1.67x |
| `AUTH_RATE_LIMIT_MEDIUM_LIMIT` (60 s) | 20 | 5 | 4x |
| `AUTH_RATE_LIMIT_LONG_LIMIT` (1 h) | 100 | 3 (one sign-in per terminal) | |
| `AUTH_RATE_LIMIT_ACCOUNT_LIMIT` (60 s, per account) | 10 | 1 | |

The previous production template (20 / 100 / 1000) would have answered a
two-terminal shop 429 inside the first hour: each dashboard terminal alone
is 540 requests an hour. The brute-force limits were not changed: 5 attempts
per 10 s per address, 20 per minute, 100 per hour, 10 per account per
minute from any number of addresses, and the account lock after
`SECURITY_MAX_LOGIN_ATTEMPTS` (5) failures for 15 minutes.

Sizing rule for a bigger shop: a terminal costs about 12 requests in a burst,
24 a minute and 1,440 an hour; the gate's `LIMITS_MIN_HEADROOM` (1.25x) is
the floor the deployment keeps. Six terminals behind one address need
`RATE_LIMIT_SHORT_LIMIT=100`, `RATE_LIMIT_MEDIUM_LIMIT=200` and
`RATE_LIMIT_LONG_LIMIT=12000`, and `AUTH_RATE_LIMIT_SHORT_LIMIT` raised to 8
if all six sign in within ten seconds of each other.

## 4. Measurement (the gate)

```bash
cd apps/api
LOAD_TARGET=http://127.0.0.1:3002 node load/limits-gate.mjs
```

Phase 1 prepares `LIMITS_SHOPS` (3) shops through the public routes, each
behind its own forwarded address, waits out the short window so the set-up
requests are not counted, then runs `LIMITS_TERMINALS` (3) terminals per
shop for `LIMITS_DURATION_S` (45) seconds: each signs in, loads its pages,
polls and bills a sale every 20 s, every terminal of a shop starting in the
same second. Every answer is recorded; the busiest sliding 10 s and 60 s of
each shop and the hourly rate the run extrapolates to are compared with the
advertised limits. Phase 2 floods one account with wrong passwords from a
fresh address (429 expected at attempt `AUTH_RATE_LIMIT_SHORT_LIMIT + 1`, a
bystander from another address still signs in, the victim's own password
from the flooding address is refused), then spreads wrong attempts over
many addresses against one account (429 at
`AUTH_RATE_LIMIT_ACCOUNT_LIMIT + 1`; the same addresses still sign in to
another account). The JSON report (`LIMITS_REPORT`) holds every request and
the verdict.

Run of 2026-10-06 against `node dist/main` with the production values
(commit of this change, MariaDB 10.11, Redis 7 on this machine):

| Check | Result |
|---|---|
| Advertised limits equal the production values | PASS (60 / 200 / 10000; auth 5 / 20 / 100; account 10) |
| Legitimate traffic: 261 requests over 3 shops x 3 terminals x 45 s | PASS, 0 x 429, 0 x 5xx |
| Busiest shop: 36 per 10 s, 82 per 60 s, 5,687 per hour extrapolated | headroom 1.67x / 2.44x / 1.76x |
| Flood from one address | 429 at attempt 6 (expected 6); bystander 201; victim's own password from the flooding address 429 |
| Attempts spread over 13 addresses against one account | 429 at attempt 11 (expected 11); another account from a used address 201 |

The hourly figure is an extrapolation of a 52-second window that contains
the page-load burst, so it overstates a steady hour; the long-window
headroom is at least what the table says.

## 5. Staging and production

Through the edge the client's `X-Forwarded-For` is discarded (roadmap 9.8),
so every request of the gate shares the caller's address: run it with
`LIMITS_SHOPS=1 LIMITS_FORWARD_FOR=0` from a machine that made no sign-in
in the previous minute, and the distributed check reports SKIPPED (it needs
distinct addresses). The legitimate phase and the flood still prove the
production values on the deployed stack:

```bash
cd apps/api
LOAD_TARGET=https://api.staging.example.com LIMITS_SHOPS=1 LIMITS_FORWARD_FOR=0 \
LIMITS_REPORT=limits-staging.json node load/limits-gate.mjs
```

The run registers throwaway shops (`limits-*@load.local`), so it is for
staging, never production. Record the result in the evidence table of
`docs/STAGING.md` with the report file.

The load profile (`load/run.sh`, roadmap 5.8) still needs the open test
limits: it drives 48 virtual users a second from one address on purpose to
measure latency, not the limiter, which is why the certify overlay opens
the limits (`scripts/certify/compose.certify.yml`) and the certify driver
skips this gate (`SMOKE_LIMITS_GATE=0`).

## 6. Billing authority (owner's policy)

Contract §2 (`docs/POS_BILLING_CONTRACT.md`). A cashier acts alone up to
these values; above them the sale needs a MANAGER or above
(`DISCOUNT_REQUIRES_APPROVAL`, `CUSTOM_LINE_REQUIRES_APPROVAL`, both 403).

| Setting | Production value | Meaning | Owner sign-off |
|---|---:|---|---|
| `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` | 10 | largest line, invoice or combined effective discount a CASHIER may apply | pending (date, name) |
| `BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT` | 500 | largest free-priced line, in rupees, a CASHIER may bill; 0 forbids custom lines for cashiers | pending (date, name) |
| Credit limit changes | MANAGER+ | `creditLimit` on a customer is refused from a CASHIER (`CREDIT_LIMIT_REQUIRES_MANAGER`), audited | by design |
| Cancellation window | business day | an invoice is cancelled on its business day only, by MANAGER+ (contract §4) | by design |

The two numeric values are the defaults the repository shipped with; the
owner confirms or changes them in the production `.env` before go-live and
dates the row. `test/integration/pos-resilience.integration-spec.ts` proves
the refusal codes at whatever values are configured.
