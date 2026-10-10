# Load test baseline (roadmap 5.8)

Recorded 2026-09-29 with `apps/api/load/` (see its README for how to
re-run) on commit 69868fd. The scenario drives the three hottest paths at
three times the assumed peak of one API instance serving a fleet of small
shops:

| Path | Route | Assumed peak | Tested (x3) |
|---|---|---:|---:|
| Checkout | `POST /api/billing/invoice`, cash sale of 1-3 units of a ZERO-GST product | 5 / s | 15 / s |
| Dashboard | `GET /api/dashboard/summary` | 10 / s | 30 / s |
| Login | `POST /api/auth/login` (bcrypt, 10 rounds) | 1 / s | 3 / s |

Phases: 20 s warm-up at 8 virtual users/s, then 60 s at 48 virtual users/s
(3,040 requests in all). Every virtual user does one request. The users
are spread round-robin over 16 shops, each with its own owner, open shift
and stocked product.

## Result (run 4, the baseline)

| Endpoint | Requests | 2xx | Errors | 5xx | Error rate | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| checkout | 928 | 928 | 0 | 0 | 0.00 % | 141.2 | **214.9** | 262.5 | 310 |
| dashboard-summary | 1940 | 1940 | 0 | 0 | 0.00 % | 22.0 | **39.3** | 50.9 | 82 |
| login | 172 | 172 | 0 | 0 | 0.00 % | 120.3 | **175.9** | 237.5 | 254 |

3,040 requests, 3,040 responses, 0 transport errors (timeouts), 0 non-2xx,
0 5xx, 3,040 virtual users completed, 0 failed.

**Exit gate (checkout p95 < 500 ms at target concurrency with 0 5xx): PASS.**

A repeat on the same day (run 5, same code plus the phase 5 hardening that
followed the audit, same environment) gave checkout p95 175.9 ms, dashboard
32.1 ms, login 179.5 ms, again 3,040 / 3,040 responses 2xx, 48.0 req/s over
the busiest five 10 s windows: the figures reproduce within noise.

Latency stayed flat through the 60 s peak phase (artillery 10 s windows,
UTC; p95 in ms):

| Window | Requests | Responses | checkout p50 | checkout p95 | dashboard p95 | login p95 |
|---|---:|---:|---:|---:|---:|---:|
| 13:54:30 | 35 | 35 | 82.3 | 89.1 | 23.8 | 92.8 |
| 13:54:40 | 80 | 80 | 82.3 | 92.8 | 21.1 | 96.6 |
| 13:54:50 | 264 | 261 | 153.0 | 223.7 | 40.9 | 179.5 |
| 13:55:00 | 480 | 480 | 135.7 | 210.6 | 36.2 | 147.0 |
| 13:55:10 | 480 | 482 | 147.0 | 210.6 | 39.3 | 141.2 |
| 13:55:20 | 480 | 479 | 141.2 | 210.6 | 39.3 | 172.5 |
| 13:55:30 | 480 | 482 | 127.8 | 183.1 | 34.8 | 135.7 |
| 13:55:40 | 480 | 477 | 149.9 | 232.8 | 40.9 | 156.0 |
| 13:55:50 | 261 | 264 | 149.9 | 219.2 | 51.9 | 162.4 |

The API log of the run holds no error, no rollback and no lock-wait retry.

## Re-run after phases 7 and 8 (2026-10-04, commit b7d9183)

The checkout transaction changed after the baseline (roadmap 8.2 moved its
raw SQL onto the application clock, 7.6 wrapped it with the
`checkoutDurationSeconds` timer), so the scenario was run again on the same
machine class with `load/run.sh`, unchanged, against the integration
database as it stood after every suite of phases 5-8 had written to it (far
more rows than the baseline run saw) and with a second MySQL 8 server
running on the host for the drift checks.

| Endpoint | Requests | 2xx | Errors | 5xx | Error rate | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| checkout | 953 | 953 | 0 | 0 | 0.00 % | 210.6 | **361.5** | 478.3 | 645 |
| dashboard-summary | 1902 | 1902 | 0 | 0 | 0.00 % | 30.9 | **59.7** | 77.5 | 132 |
| login | 185 | 185 | 0 | 0 | 0.00 % | 127.8 | **252.2** | 415.8 | 484 |

3,040 requests, 3,040 responses, 0 transport errors, 0 non-2xx, 0 5xx,
48.0 req/s over the busiest five 10 s windows, 3,040 virtual users created
and completed. **Gate: PASS** (`summarize.mjs`). The checkout p95 is higher
than the baseline's 214.9 ms; the data volume and the second database
server are the visible differences, and the gate margin (500 ms) holds with
room. Compare the next run against this row, not the 2026-09-29 one.

The upload half was re-run the same day (`load/upload-gate.sh`, 12 x 300 MB):
12 x HTTP 413 in 0.31-0.55 s, RSS 256.8 MB before, 292.4 MB peak, 277.8 MB
after (growth 21.0 MB, allowed 64 MB), 0 temp files left, the 5 KB control
PNG answered 201. **Upload gate: PASS.**

## Environment

The numbers are from a development container, not production hardware,
and the load generator ran on the same machine as the API and the
database. They are a baseline to compare future runs against, not a
capacity statement.

| Item | Value |
|---|---|
| Code | commit 69868fd (`git rev-parse` printed by `run.sh` on every run) |
| Machine | 4 vCPU Intel Xeon 2.10 GHz, 16 GB RAM, Linux 6.18 |
| API | `node dist/main` (Node 22.22.2), one process, `NODE_ENV=test` (so `.env.test` applies: rate limits effectively off, `BILLING_TRANSACTION_MAX_WAIT_MS` 120 s, gateway timeout 60 s), `CRON_ENABLED=false` (no outbox relay, no nightly jobs: the per-sale background work production does in the same process is absent), `PRISMA_LOG_QUERIES=false` |
| Database | MariaDB 10.11.14 on the same host, the integration database `dukaanai_test`, `innodb_buffer_pool_size` 128 MB, `innodb_flush_log_at_trx_commit=1`, Prisma `connection_limit=25&pool_timeout=120` (production is MySQL 8) |
| Redis | 7.0.15 on the same host, db 2 |
| Load generator | artillery 2.0.34 (pinned in `run.sh`) on the same host (about one full core during the peak phase); arrivals evenly spaced (artillery's default), latency measured to the first response byte over a 64-connection keep-alive pool |
| Data | 16 shops, one product each, one-line cash baskets of a ZERO-GST product; each shop ends the run with about 60 invoices |
| CPU during the peak phase | machine 55-85 % busy: API 120-230 %, artillery 80-140 %, MariaDB 10-50 %, Redis under 10 % (of one core each) |

What the scenario does not measure: multi-line baskets, GST and discount
math, credit sales, returns, the single-shop ceiling with query logging off
(run 1 measured it only with logging on), the rate limiter, and the outbox
work of a sale. Extend the scenario before reading its numbers as any of
those.

## How the baseline was reached (runs 1-3, not the baseline)

| Run | Change | checkout p95 | dashboard p95 | login p95 | Errors | Gate |
|---|---|---:|---:|---:|---:|---|
| 1 | one shop for all checkouts, per-query logging on | 13,498 ms | 3,753 ms | 3,606 ms | 1,511 socket timeouts (30 s) on the client; the API log shows 41 transaction-timeout 500s (Prisma P2028) and 146 shutdown 500s the clients never received, and 20 lock-wait rollbacks retried | FAIL |
| 2 | 4 shops, per-query logging still on (see below) | 5,945 ms | 2,144 ms | 2,618 ms | 0 | FAIL |
| 3 | 16 shops, per-query logging still on | 773 ms | 130 ms | 392 ms | 0 | FAIL |
| 4 | 16 shops, per-query logging off | 215 ms | 39 ms | 176 ms | 0 | PASS |

Two findings came out of it, both kept in the repository:

- A checkout holds the shop's shift, number-sequence and product rows for
  the length of its transaction (the canonical lock order of
  `BillingService.createInvoice`), so one shop bills serially by design and
  a single shop cannot absorb a fleet peak of 15 sales/s: run 1 queued on
  those rows until requests timed out. The peak is therefore a fleet figure
  and the scenario spreads its users over `LOAD_SHOPS` shops (16).
- `PRISMA_LOG_QUERIES` was read into `PrismaConfig` and then ignored:
  `PrismaService` logged every query under any non-production `NODE_ENV`
  (about 100,000 lines per run), which cost run 3 its gate. The flag is
  honoured now (`PrismaService.logLevelsFor`); `.env.test` and
  `.env.development` still say `true`, the integration setup file forces
  `false`, and the load runner turns it off.

## Upload half of the gate (300 MB rejected with 413, no memory growth)

Measured the same day with `apps/api/load/upload-gate.sh` (committed; the
first measurement, in the phase 5.1 commit message, was three uploads by
hand): twelve 300 MB multipart uploads to `POST /api/media/upload/product/:id`
against the same API profile.

| Figure | Value |
|---|---|
| Responses | 12 x HTTP 413 `PAYLOAD_TOO_LARGE`, 0.31 s to 0.56 s each |
| API RSS | 242.0 MB before, 279.2 MB peak during, 248.6 MB after (growth 6.6 MB, allowed 64 MB) |
| Temp directory after the run | 0 files |
| Control | a 5 KB PNG to the same route answers 201 |

**Upload gate: PASS.** The 413 comes from multer's `fileSize` limit
(`UPLOAD_MAX_MEDIA_BYTES`, 50 MiB) with the body streamed to disk and the
partial file deleted by multer; the request body is drained, not buffered,
so the plateau is the process's working set, not the upload. The storage
and OCR routes keep capped memory storage (10 MiB x 5, 25 MiB, 10 MiB) and
are bounded by those caps rather than by disk.

## Re-running

```bash
cd apps/api
LOAD_DATABASE_URL='mysql://user:pass@127.0.0.1:3306/dukaanai_load?connection_limit=25&pool_timeout=120' \
LOAD_REDIS_URL='redis://127.0.0.1:6379/2' \
load/run.sh          # checkout / dashboard / login at 3x peak
load/upload-gate.sh  # 12 x 300 MB uploads, RSS sampled
```

Update this file after a change to the checkout transaction, the
dashboard queries or the login path, and whenever the deployment target
changes; compare like with like (same machine class, same database
engine, load generator on another host where possible).
