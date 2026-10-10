# Changelog

All notable changes to DukaanAI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How it is kept (`RELEASE.md`): a change that will ship gets its line under
`[Unreleased]` in the same pull request; cutting a release renames that section
to `## [vX.Y.Z] - YYYY-MM-DD` and bumps the version in the same commit. CI
(`scripts/release/release.mjs lint`) refuses a malformed file, the release
workflow refuses a tag without its dated section, and the section becomes the
release notes of the tag.

## [Unreleased]

### Fixed

- The release Trivy gate (9.14) failed on the first images built from main: every image now takes Debian's security
  updates at build time (`apt-get upgrade`; db-ops keeps its MySQL packages at the base release), the API and web
  runtime images no longer carry the npm / npx / corepack bundled with the Node image, and db-ops drops the unused
  `gosu` binary. The migrate step runs the image's Prisma CLI by path (`/app/node_modules/.bin/prisma migrate deploy`)
  in compose, the production compose file, the Kubernetes Job and the certify migrate check.

## [v1.0.0-rc3] - 2026-10-08

The first version tagged in git (v1.0.0-rc1 and v1.0.0-rc2 below never were). It covers everything after v1.0.0-rc2
(commit eb43d72, 2026-06-21): the work before the hardening roadmap, the execution tasks EXEC-001 to EXEC-006C, and
roadmap phases 0 to 9 (rows 0.1 to 9.22). A number in parentheses is a roadmap row (2.6 is phase 2, row 6); a
seven-character hex string is a commit.

Owner-side for this candidate (`RELEASE.md`, `docs/STAGING.md`, `docs/PILOT.md`): pushing the tag, the deployment to
staging with its rehearsed rollback, the pilot in a shop, the external penetration test
(`docs/security/PENTEST_SCOPE.md`) and the approval.

### Upgrade notes

- **A database created by v1.0.0-rc1 or v1.0.0-rc2 does not upgrade with `migrate deploy`.** On 2026-07-17 (9c300f8)
  the five rc2 migrations were replaced by one baseline, `20260717185000_schema_baseline`, because the old chain did not
  reproduce the schema. Such a database with business data moves by `apps/api/SCHEMA_RECOVERY.md`: verified backup, new
  empty database, `migrate deploy`, a reviewed import, smoke test, then the switch. A database created from the
  baseline (any build since 2026-07-17) upgrades in place.
- Node.js 22.12 or newer and `NODE_ENV` are required (no default; `.env.<NODE_ENV>` is read only when it is set);
  `npm run start:prod` runs `NODE_ENV=production node dist/main`. (0.5, 2.4)
- Take a backup, then run `npx prisma migrate deploy` (compose runs it as the one-shot `migrate` service): 22 new
  migrations, `20260918120000` to `20261008090000`. `prisma db push` and the `db:push` script are gone. (3.12, 7.3, 7.7)
- A failed migration follows the `migrate resolve` runbook in `prisma/MIGRATIONS.md`; the known case is the first
  version of `20260919090000_pos_correctness_foundation`, which failed on MySQL 8. (3.12)
- Migrations that rewrite data: `20260919090000` merges duplicate inventory items, `20260929170000` keeps the newest
  duplicate recommendation, `20261004090000` closes older duplicate open shifts, `20261004120000` reduces colliding
  rows to one. (EXEC-006C, 4.9, 8.3, phase 8 gate)
- `20261003130000_data_model_integrity` backfills USD currency defaults to INR and adds Shop foreign keys to 65 tables,
  failing on orphan rows: count them first with the query in `prisma/MIGRATIONS.md`. (8.1)
- With binary logging on, the migration user must be allowed to create triggers (compose starts MySQL with
  `--log-bin-trust-function-creators=1`). The backup user needs RELOAD and REPLICATION CLIENT, the binlog archive
  REPLICATION SLAVE. (7.3, 9.2)
- Rate-limit windows are `RATE_LIMIT_{SHORT,MEDIUM,LONG}_TTL_MS` in milliseconds (the `RATE_LIMIT_*_TTL` keys are
  ignored); defaults are now 60 per 10 s, 200 per 60 s and 10,000 per hour per address. (2.1, 9.16)
- `TRUST_PROXY` (default false) decides whether `X-Forwarded-For` counts: set it behind a proxy (1 behind the bundled
  edge), or every client shares the proxy's rate-limit bucket. (2.1, 9.8)
- Production refuses to boot with a weak or placeholder `JWT_SECRET`, a placeholder `FRONTEND_URL`, `AUTH_DISABLED=true`,
  a relative `STORAGE_ROOT`, `LOG_LEVEL` debug or verbose, or a placeholder `SENTRY_DSN` or `METRICS_TOKEN`. (2.3 to 2.5, 7.5, 7.6)
- Removed variables include `JWT_REFRESH_SECRET`, `QUEUE_CONCURRENCY` and `QUEUE_TIMEOUT` (full lists under phases 2,
  4 and 8); `apps/api/.env.example` documents every variable the API reads. (2.3, 4.6, 8.5)
- The images carry no env file and default to the `.env.production` values: set secrets and URLs in compose or
  Kubernetes, including `SMTP_URL`, `GEMINI_API_KEY` and the API's `GOOGLE_CLIENT_ID` (503 without them). (2.8, 4.4, 9.19)
- Redis: the cache lives in Redis under `cache:<key>`, BullMQ uses the database index in `REDIS_URL`, and `rediss://`
  turns TLS on. (EXEC-005, 2.11, 2.12)
- Web: production refuses `NEXT_PUBLIC_AUTH_DISABLED` and a placeholder `NEXTAUTH_SECRET`; `API_PUBLIC_URL`,
  `API_INTERNAL_URL` and `NEXT_STANDALONE` are new; `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED` is no longer read. (2.3, 6.4, 7.3, 9.9, 9.19)
- Access tokens last 15 minutes and must name a live session; tokens issued before the upgrade are refused, so expect
  clients to refresh or sign in again. Sessions end after `SESSION_ABSOLUTE_LIFETIME` (12 h by default). (2.6, 9.19)
- After rotating `JWT_SECRET`, run `npm run sessions:revoke-all -- --yes`. Passwords set from now on need 12 to 72
  characters; Google sign-in never links to an existing password account (409). (2.7, 2.9, 9.11, 9.15)
- Every write route declares its roles (VIEWER is refused on role-gated writes), and shops that are not ACTIVE get 403.
  (1.1, 1.2, 1.8)
- Cashiers bill only on their own open shift; discounts above `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` (default 10) need a
  manager, and custom lines are capped by `BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT` (default 500). (EXEC-006C, 3.5, 3.6)
- Removed routes answer 404: `/invoices/generate`, `/returns/initiate`, `/payments/capture`, `/sales/orders`,
  `/sales/workflow`, `/pricing/simulate`, `/events/replay`; `/billing/*` is the one invoice, return and payment path. (4.5)
- Lists return at most 200 rows (default 100) through `skip`/`take` (procurement lists: `limit`/`offset`); totals are
  in `X-Total-Count`, `X-Page-Skip` and `X-Page-Take`. (5.6)
- Webhook deliveries are signed `x-dukanai-signature: t=<ms>,v1=<hex HMAC-SHA256(secret, "<ms>.<body>")>`; targets
  must be public https URLs and redirects are not followed. (4.8)
- Uploads are capped (media 50 MiB, imports 20 MiB, bill images 10 MiB; 413 above) and checked by content; SVG is no
  longer accepted and imports are CSV or JSON only. (4.4, 5.1)
- Operations: readiness is `GET /api/health/ready`; `GET /api/metrics` needs the `METRICS_TOKEN` bearer token;
  `docker-compose.prod.yml` pulls by `IMAGE_TAG`; old customer folders move with `npm run storage:migrate-legacy`. (7.3, 7.6, 8.4, 9.9)
- The images say which release they are: `GET /api/health` on the API and the web answers `release`, the API exports
  `build_info{release}`, and the OCI labels carry the version and the commit. The compose files no longer set
  `APP_RELEASE` (an entry, even a blank one, replaced the image's own value). (9.21)
- Rolling back to an earlier release follows `RELEASE.md` ("Rollback"): this release's last migration,
  `20261008090000_onboarding_imports`, is additive, but an earlier build cannot read the ledger rows of an opening
  balance (a product created with stock, an opening stock or udhar import), so once one exists the way back is the
  next fix, not the old image. Rehearsed: rollback and roll forward in 25 s each. (9.20, 9.21)

### Phase 9: Data safety and production certification (9.1 to 9.22)

#### Added
- `docs/DATA_SAFETY.md`: recovery objectives (database RPO 5 min / RTO 1 h, documents 24 h / 4 h), every store and what
  protects it, and a measured restore; product images joined the backups. (9.1)
- Point-in-time recovery: dumps record their binary-log position, `binlog-archive.sh` archives closed logs (every 300 s
  through the `binlog-archiver` service), and `restore.sh --to "<UTC time>"` replays them. (9.2)
- Documents backup `scripts/storage/` (per-file SHA-256 manifest, verified restore) and encrypted off-site copies
  `scripts/backup/offsite.sh` (rclone crypt), with drills that restore from the copy. (9.3, 9.4)
- Backup monitoring: `backup_last_success_timestamp_seconds{kind}` and the alerts `DukaanAiBackupStale` and
  `DukaanAiBackupNeverRecorded`, tested with promtool. (9.4)
- Financial reconciliation of a business day (`src/reconciliation`): documents, postings, tenders, dashboard, shifts,
  stock and ledger checked to the paisa with named drifts; it reports and never corrects. (9.5)
- Nightly reconciliation of every shop (`CRON_RECONCILIATION`, 01:30), `GET /reconciliation/*` and
  `POST /reconciliation/run` (OWNER, ADMIN), `npm run reconcile`, drift and stale alerts. (9.5)
- `Clock`, the one "now" for POS documents, and a test that bills across 31 March and 1 April (sequences restart,
  cancellation window, dashboard day, reconciliation). (9.6)
- Production topology: managed MySQL 8 over verified TLS, managed Redis, one API replica, `docker-compose.prod.yml`
  with a `backup-agent`, and Kubernetes manifests in `deploy/k8s`. (9.7)
- HTTPS edge `deploy/edge/Caddyfile` (automatic certificates, HSTS, client `X-Forwarded-For` discarded, 64 MB bodies,
  `/api/metrics` hidden), proven in CI by `scripts/compose-smoke-prod.sh`. (9.7, 9.8)
- `.github/workflows/release.yml` builds the API, web and db-ops images once per commit or tag and pushes them to
  ghcr.io; one web image serves every environment (`API_PUBLIC_URL`); `docs/STAGING.md`. (9.9)
- Monitoring stack (`deploy/observability/compose.yml`, profile `ops`): Alertmanager routing to on-call and team,
  blackbox probes, Loki, Alloy and Grafana; one access-log line per API answer. (9.10)
- `docs/SECRETS.md`, `npm run sessions:revoke-all` (revokes every refresh token and bumps every `tokenVersion`), and
  gitleaks over the tree and the full history in CI. (9.11)
- Release certification: the `certify` job re-runs the checks against the pushed images and attaches the evidence
  bundle to the tag's release. (9.12)
- Exploit replay `apps/api/test/certification/exploit-replay.ts` (`npm run certify:exploits`): twelve audit findings
  replayed over HTTP against a deployment, each expected to be refused. (9.13)
- Supply chain: `scripts/certify/trivy-scan.sh` blocks fixable HIGH and CRITICAL vulnerabilities, writes a CycloneDX
  SBOM per image and proves itself on a known-vulnerable image. (9.14)
- `apps/api/load/limits-gate.mjs` (a shop's traffic gets no 429, floods do) and `docs/PRODUCTION_LIMITS.md`. (9.16)
- Simulated business day (`load/business-day.*`, `docs/BUSINESS_DAY.md`): 10 shops and 3,200 sales through a Redis
  restart and a killed API instance, nothing lost or billed twice, every shop reconciled CLEAN. (9.17)
- Failure drills `scripts/drills` (API kill, MySQL stop, Redis stop, full volume, expired certificate, off-site
  restore) with a browser observer; results in `docs/DRILLS.md`. (9.18)
- Pilot preparation: `docs/PILOT.md`, `apps/web/e2e/pilot-preflight.spec.ts` (scanner, slow tablet, phone, printing,
  slow network, large photos) and the day-0 check `scripts/pilot/readiness.mjs`. (9.19)
- Onboarding imports and the first-day procedure (`docs/ONBOARDING.md`): products, opening stock and customers with
  their opening udhar through `POST /imports/{products|customers|opening-stock}/upload`, each as a dry run with a
  per-row report (`GET /imports/jobs/:id/rows`, `/errors`, `/report` as CSV) and then `POST /imports/jobs/:id/apply`;
  templates from `GET /imports/templates/:kind` and `docs/onboarding/*.csv`. A re-run changes nothing, an opening is
  never overwritten, and opening udhar and opening stock post against the new OPENING_BALANCE_EQUITY account
  (`20261008090000`), so the reconciliation stays CLEAN. Proven with 5,000 products and 2,000 customers on MySQL 8 and
  MariaDB. (9.20)
- Versioned releases: `scripts/release/release.mjs` (`check` before a tag is pushed and again in the workflow, `notes`,
  and `lint` in CI); the release workflow builds nothing for a tag that is not a release, never rebuilds a published
  version, bakes the release and the commit into the images and opens the draft release with this file's section;
  certify checks that the running images report the tag; `RELEASE.md` is the procedure from the backup to the
  rollback. (9.21)
- `docs/RUNBOOKS.md`: a page per alert (what it means, first checks, fix, how to verify, what to tell the shops),
  incident roles and severities, status messages for shop owners and the post-incident review template. Every alert
  links its page (`runbook_url`, shown in Slack and PagerDuty), and `runbooks.spec.ts` fails on an alert without one.
  Every page was walked on the drill stack with one injected fault and corrected where it was wrong (its section 7).
  (9.22)
- `EDGE_BLOCKED_IPS`: addresses or ranges the edge answers 403, set in `.env` (no Caddyfile edit on the server).
  (9.22)

#### Changed
- One password policy wherever a password is set (12 to 72 characters, common passwords refused); new
  `POST /auth/change-password`; reset and change email the account. (9.15)
- Login outcomes and refused role checks are logged, every API answer has `Cache-Control: no-store`, and
  `DukaanAiCredentialFlood` alerts; `docs/security/ASVS_L2.md` records the review. (9.15)
- General rate limits default to 60 per 10 s, 200 per 60 s and 10,000 per hour per address; the old values refused a
  two-terminal shop within the hour. (9.16)
- Alerts after the drills: a 2-minute 5xx ratio without health routes, `DukaanAiDependencyDown`, storage volume
  alerts, and `DukaanAiCertificateExpired`, which holds back the endpoint alert. (9.18)
- Image defaults equal `.env.production` (production ran 30-day sessions and 14 other differing defaults), kept so by
  `production-defaults.spec.ts`. (9.19)
- Google sign-in: the API reads `GOOGLE_CLIENT_ID`, compose and Kubernetes pass it, and the web decides the button at
  run time and says why a sign-in failed. (9.19)
- POS search lists rows holding the whole query first, then full-text matches; a product typed in full was lost once
  more than 100 products shared one of its words. (9.19)
- Photos are scaled before upload, and `OCR_TOTAL_TIMEOUT_MS` keeps bill scanning under the edge's 60 s. (9.19)

#### Fixed
- Every import job stayed PENDING: the worker read its job through a Prisma promise returned unawaited from
  `runAsSuperAdmin`, which then ran outside the tenant context; `runInShopOf` had the same shape. (9.20)
- The web signed every owner out after one access-token lifetime (parallel reads presented a consumed refresh token);
  `src/lib/refresh-handoff.ts` hands late callers the successor. (9.17)
- Outages: the database answered 500 (now 503 `DATABASE_UNAVAILABLE` with `Retry-After`), a full volume kept a
  truncated photo (now 507 `STORAGE_FULL`), and a Redis outage hung sales and the metrics scrape. (9.18)
- POS checkout and returns offer Retry with the same key on any 5xx, and a POS opened during an API restart recovers by
  itself. (9.18)
- Barcode scans were dropped on a slow device and could confirm the payment panel or overwrite the focused field; a
  shared barcode now opens a picker with price and stock. (9.19)
- Receipts printed CGST, SGST and IGST as ₹0.00; a return receipt names the sale it reverses; prints use the light
  theme; the phone menu no longer starts open over the POS. (9.19)
- A refused invitation email blocked the address for 48 h (now 502 `INVITATION_EMAIL_FAILED`, no row); email failures
  are counted and alerted. (9.19)
- Operations: db-ops on the Debian MySQL image (it has `mysqlbinlog`), the Kubernetes secrets template name, the
  compose stack's API URL behind the edge, smoke checks under `pipefail`. (9.2, 9.7, 9.18)
- Alerts that could not fire, found by walking the runbooks: the first ledger-posting, email or tracked-error failure
  after a start never paged (a labelled counter born at 1 shows no `increase()`; every alerted series now exists at 0,
  `alerted-series.spec.ts`), and a paused queue reported 0 waiting jobs, so `DukaanAiQueueBacklog` stayed silent
  (paused jobs count as waiting; new `queue_paused`). (9.22)
- Logs the runbooks search: a 500's error line and every login outcome carry the request's correlation id as a field
  (the login lines the client address too); alert descriptions round their counts. (9.22)
- The binlog archiver and the backup agent ignored SIGTERM as PID 1 and were killed after the grace period (exit 137);
  they now stop at once between runs. (9.22)
- The operator commands the runbooks and `docs/SECRETS.md` name were not in the API image (`npm run reconcile` and
  `npm run sessions:revoke-all` answered `ts-node: not found` there): `node dist/cli/reconcile` (with `--all-shops`
  for a missed night) and `node dist/cli/revoke-all-sessions` ship with the API. (9.22)
- A deploy resolved a firing alert read from an API gauge (one failed scrape) and restarted its hold time; those
  alerts now keep firing 2 minutes (`keep_firing_for`). (9.22)

### Phase 8: Data model, scripts and configuration (8.1 to 8.6 and the phase gate)

#### Added
- Spec guards in `npm test`: `schema-conventions.spec.ts` (schema lint), `sql-clock.spec.ts`,
  `inventory-authority.spec.ts` (no stock write outside the engine) and `env-example.spec.ts`. (8.1 to 8.5, gate)

#### Changed
- `20261003130000_data_model_integrity`: Shop foreign keys on 65 tables (RESTRICT), an explicit `MediaAssetTag` model,
  stock quantities as `Decimal(12,3)`, TEXT for notification messages and outbox errors, INR as the currency default. (8.1)
- Raw SQL stamps rows with the application's UTC time, not the database clock, which was off by the server's offset in
  stock moves, outbox claims, number sequences, ledger balances and payables. (8.2)
- The database allows one open shift per cashier (`Shift.openToken`, `20261004090000`); a losing concurrent open
  answers 409 `SHIFT_ALREADY_OPEN`. (8.3)
- No unique key relies on a nullable column except recorded cases; snapshot and price-list keys use NOT NULL token
  columns (`20261004120000_unique_key_tokens`). (gate)
- `scripts/migrate-storage.ts` works one shop at a time, dry run by default, leaves ambiguous names in place and writes
  a manifest. (8.4)
- `apps/api/.env.example` documents all 132 variables the API reads; the POS contract, environment architecture,
  `ENVIRONMENT_REQUIREMENTS.md`, README and deployment checklist were rewritten against the code. (8.5, 8.6)

#### Removed
- `check-db.ts` (printed every customer of every shop), the `verify-exec006a/b` scripts and the unused
  `ci/check-inventory-authority.ts`. (8.4)
- Fourteen placeholder config domains, `QueueConfig` and `SwaggerEnvironmentRule`. (8.5)
- Variables no code read: `CACHE_MAX_ITEMS`, `CACHE_SEARCH_ENGINE_TTL_MS`, `PRISMA_SLOW_QUERY_THRESHOLD`,
  `SALES_DEFAULT_PAGINATION_LIMIT`, `SALES_CREDIT_HOLD_THRESHOLD`, `QUEUE_CONCURRENCY`. (8.5)

#### Fixed
- Concurrent shift opens on MySQL 8 could answer a raw deadlock error; the open reruns and answers 409. (7b0d9d5)
- `npm run clean` and `test:debug` work in the workspaces. (8.4)

### Phase 7: Dependencies, deployment and operations (7.1 to 7.8)

#### Added
- Container images: `apps/api/Dockerfile` (pinned Node 22 on Debian slim, production dependencies, non-root, runs the
  migrations) and `apps/web/Dockerfile` (Next standalone output). (7.3)
- `docker-compose.yml` with a root `.env.example` (MySQL 8, Redis 7, a one-shot `migrate`, API, web);
  `scripts/compose-smoke.sh` takes a fresh clone to a sale and a clean stop in CI. (7.3)
- Probes: liveness `GET /api/health` and `/api/health/live`, readiness `GET /api/health/ready` (database and Redis; 503
  while draining); the web has `GET /api/health`. (7.3)
- Graceful shutdown: readiness turns 503, workers finish their jobs, the server closes before Prisma and Redis, a
  watchdog bounds it, and the process exits 0 instead of 143; `docs/DEPLOYMENT.md`. (7.3)
- Prometheus metrics at `GET /api/metrics` (bearer `METRICS_TOKEN`): requests and latency by route, checkout time,
  ledger posting failures, outbox and queue depth. (7.6)
- `LOG_LEVEL`; Sentry error tracking behind `SENTRY_DSN` (no request data, real 500s only); alert rules
  `deploy/prometheus/alerts.yml` checked by promtool; `docs/OBSERVABILITY.md`. (7.6)
- MySQL backups `scripts/db/backup.sh`, `restore.sh` and `restore-drill.sh` (restore, migrate status and diff, row
  counts, triggers), run in CI on MySQL 8; `db-ops` service; `docs/BACKUP_RESTORE.md`. (7.7)
- Retention sweep (`CRON_RETENTION_SWEEP`, 03:30) deletes expired tokens, finished outbox rows, old search history and
  event logs in bounded batches, with supporting indexes (`20261003090000`). (7.8)
- `scripts/check-tracked-artifacts.sh` (no uploads, storage documents, logs or dumps in git) and
  `dependency-declarations.spec.ts` (every API import declared). (7.4, 7.7, 6b4bf4b)

#### Changed
- Dependency updates (next-auth, multer, sharp, axios, Nest 11.2.7, socket.io, nodemailer, mysql2), `prisma` and
  `@prisma/client` pinned to 6.19.3, scoped `overrides`; `tailwindcss-animate` is a dev dependency. (7.1, ae1fc4e)
- The web runs Next.js 16 on React 19, lints with ESLint 9 (`eslint .`), and `middleware.ts` became `proxy.ts`. (7.2)
- Billing evidence is written once: a repeat is 409 `STORAGE_EVIDENCE_EXISTS` and nothing is partly written;
  statements get a unique file name per generation. (7.5)

#### Removed
- `xlsx`, `joi`, `lodash`, `fluent-ffmpeg`, `fuse.js` and stale type packages from the API; tracked turbo logs and
  storage files. (7.1, 7.4)

#### Fixed
- The API image died with `MODULE_NOT_FOUND` for `uuid`, which only the web had pulled in; `uuid`, `cache-manager`,
  `cron`, `express` and `@nestjs/mapped-types` are declared. (6b4bf4b)
- MySQL 8 stored a ledger trigger in a form that made every dump unrestorable; `20261003090100` recreates both
  triggers with `BEGIN ... END` bodies, and `backup.sh` repairs older dumps. (7.7)
- Prisma disconnected before the server closed and failed in-flight requests. (7.3)

#### Security
- `npm audit --omit=dev` went from 27 findings (2 critical, 19 high) to none, and CI fails on any high or critical
  production advisory. (7.1, 7.2)
- Every GitHub Action is pinned to a commit with Dependabot moving the pins; `pullfrog.yml` runs only on manual
  dispatch with read-only contents, no persisted credentials and only the secrets it uses. (7.4)
- Storage paths stay under a root resolved once (`..`, absolute segments and sibling prefixes are refused), responses
  carry shop-relative paths, and every storage route checks that the customer belongs to the shop. (7.5)

### Phase 6: Web application (6.1 to 6.9)

#### Added
- Password reset: `POST /auth/forgot-password` (the same answer for every address, link by email) and
  `POST /auth/reset-password` (single-use token for one hour, ends every session), with their pages. (6.7)
- `GET /expenses/summary` for the expense tiles and a real expense edit (`PATCH /expenses/:id`). (6.7)
- Error pages `app/error.tsx` and `app/global-error.tsx`. (6.5)
- Browser suites: fake-flows, persistence (every mutating action checked after a reload), hardening, correctness and a
  real-auth suite with a VIEWER who sees no write buttons; `docs/WEB_GATE_EVIDENCE.md`. (6.1 to 6.9)

#### Changed
- Employees: real accounts, suspend, reinstate and remove (OWNER or ADMIN, never yourself), invitations by email; the
  register page joins a shop with `?invite=<code>`. No page shows success without a saved change. (6.1)
- Suppliers edit and delete through the API (the row leaves after the API answers) and send the payment mode; "Add
  Supplier" is hidden from roles the API refuses. (6.1, 6.9)
- Smart Capture stores the photo, and optionally a one-page PDF built in the browser, through
  `POST /storage/bills/:customerId/:billId`, and can hand the frame to the bill scanner. (6.1)
- The bill scanner (`/ai-scanner`) calls `POST /ocr/scan-bill`, shows matches with their confidence, exports CSV,
  reports 503 and 502 as failures and no longer claims to update stock. (6.1)
- Products page: server paging (50 per page), debounced search that follows the navbar's `?q=`, stock and category
  filters in the API, tiles from `GET /dashboard/summary`, real edit and delete. (6.2, 6.6)
- Product forms send typed fields only (cost price required, MRP at least the selling price, GST slab and unit as
  selects); a blank SKU is numbered by the API (`SKU-000001`). (6.2)
- Settings: the shop profile saves city, state (a picker, since IGST depends on it), PIN code, phone and email; Account
  & Security lists your sessions with revoke and sign-out. (6.3)

#### Removed
- The `/ai-assistant` and `/database` placeholder pages (no backend), payroll and attendance mock-ups, "Billing &
  Plans", the inventory transfer button and the adjustment modal that saved nothing. (6.1, 6.3, 6.7)
- 13 unused web dependencies and `@types/uuid`, `data/customers.json`, unused components, hooks, helpers and types;
  charts now load on demand (`next/dynamic`). (6.8)

#### Fixed
- Uploads from the web were sent as JSON (`{"file":{}}`), and every storage upload failed as a path traversal because a
  relative `STORAGE_ROOT` was compared with an absolute path. (6.1)
- The POS could overwrite the saved cart with an empty one before hydration; an anonymous cart now moves into the
  shop's scope and the scanner waits for it. (6.5)
- Late responses no longer overwrite newer ones (shift banner, notifications); API calls time out after 15 s; one UUID
  helper works without `crypto.randomUUID`. (6.5)
- Receipt and invoice show the cess row; print styles apply per page; a customer edit can clear optional fields; empty
  batch dates render; pinch-zoom works. (6.7)

#### Security
- Security headers on every page (HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy`), and no `X-Powered-By`. (6.4)
- A per-request Content-Security-Policy with a script nonce and `'strict-dynamic'`, `connect-src` limited to the API,
  `frame-ancestors 'none'` and `form-action 'self'`. (6.4)
- The middleware verifies the session token instead of checking that a cookie exists; `callbackUrl` is honoured only
  as a same-origin path. (6.4)
- Production builds refuse `NEXT_PUBLIC_AUTH_DISABLED` and compile the bypass out. (6.4)

### Phase 5: Denial of service and performance (5.1 to 5.8)

#### Added
- Load test `apps/api/load` (artillery 2.0.34; checkout, dashboard and login at three times the assumed peak over 16
  shops) gated by `summarize.mjs` and `upload-gate.sh`; baseline in `docs/LOAD_TEST_BASELINE.md` (checkout p95 215 ms). (5.8)

#### Changed
- Search history writes have a per-shop budget (`SEARCH_HISTORY_MAX_PER_MINUTE`, default 120, counted in Redis);
  searches past it are answered but not recorded. (5.3)
- The dashboard's all-time totals are cached for 60 s and dropped after every sale, return and cancellation; they were
  recomputed over every invoice on each poll. (5.5)
- Every list route is a capped page with `X-Total-Count`, `X-Page-Skip` and `X-Page-Take` headers (exposed through
  CORS); nested lists are capped too, and every paged order ends in `id`. (5.6)
- The auth, tenant and role guards run once as global guards (32 controllers repeated them); low-stock notifications
  take three statements per sale instead of three per line. (5.7)

#### Fixed
- Upload temp files survived a validation 400, an ownership 404 or a deduplicated upload; `UploadCleanupInterceptor`
  removes them. (5.1)
- A repeated query parameter (`?q=a&q=b`) answered 500 on `/search`, `/search/suggestions` and `/products`. (5.3)
- Stock reconciliation paged with `skip` and could skip or repeat rows; it walks `Product(updatedAt)` by keyset in a
  window fixed at the start of the run, so it always ends under continuous sales. (5.4)
- Two concurrent category moves could build a cycle, and a move to the root detached the subtree; a move now locks both
  rows and re-roots the subtree in one UPDATE. (5.7)
- `PRISMA_LOG_QUERIES` was ignored and every query was logged outside production. (5.8)

#### Security
- Every multipart route has hard limits (file size, file, part and field counts), a declared-type filter and disk
  storage; three 300 MB uploads now cost about 36 MB of memory where the audit measured 440 MB for one. (5.1)
- Stored bytes must match the declared type (images, video, PDF, Office, glTF by magic number; CSV and JSON as readable
  UTF-8), or the file is deleted and the request is 400; SVG is no longer a media type. (5.1)
- Variant generation is bounded before it starts: 8 attributes, 100 values each, at most 1,000 combinations (400
  `VARIANT_MATRIX_TOO_LARGE`), re-checked in the service. (5.2)
- Search input is cut to 100 characters wherever it is read, and synonym expansion makes one lookup for at most 8
  tokens and stops at 24 terms. (5.3)

### Phase 4: Scaffolding modules (4.1 to 4.9 and the phase gate)

#### Added
- `NumberSequenceService`: per-shop numbers under a row lock (`PO-YYYYMM-00001`, `GRN|PR|VB|SCN-<FY>-000001`, POS
  invoices and returns); no document number comes from `Date.now()`. (4.2)
- Goods receipts are bound to their order (`20260929140000`): quantities and prices come from the order line, accepted
  quantities never exceed the order, and acceptance stocks, posts and moves the order to (partially) received. (4.2)
- Approvals open one pending row and refuse the creator (403 `SEPARATION_OF_DUTIES`); vendor-bill matching is
  cumulative; credit notes are worth their lines and settle only a posted bill of their supplier. (4.2)
- Warehouses and locations: MANAGER or above, codes unique per shop and per warehouse (409), parents in the same
  warehouse. (4.3)
- One outbox semantic (`OutboxClaimService`): claim, enqueue after commit, the worker settles DONE, retries with backoff
  or FAILED; a reaper frees stale claims; operators list and retry rows with `/sales/events`. (4.7)
- Nightly analytics per shop: ABC and XYZ classes from net sales, REORDER and LIQUIDATE recommendations that keep a
  user's DISMISSED status on re-run, batched writes and pruning of old rows. (4.9)
- `route-walker.integration-spec.ts` calls every handler as nobody, a VIEWER, the OWNER and another shop's OWNER:
  never 5xx, 401 except `@Public`, 403 for the VIEWER on gated writes, no 2xx for a foreign id. (gate)

#### Changed
- `VariantIdentity.sku` is unique per shop (409 `SKU_IDENTITY_IN_USE`); a barcode clash answers 409 `BARCODE_IN_USE`.
  (4.1)
- Procurement writes run in `procurementTransaction` (READ COMMITTED, 30 s, retried on deadlock) and lock the order,
  then the products. (4.2)
- Bill scanning uses `OCR_MODEL`, retries the model with backoff, answers 503 or 502 with a code (not configured,
  unreachable, timeout, unreadable) and keeps at most `OCR_MAX_ITEMS` lines. (4.4)

#### Removed
- Duplicate stacks `/invoices/generate`, `/returns/initiate`, `/payments/capture`, `/sales/orders`, `/sales/workflow`,
  `/pricing/simulate`, `/events/replay` and a second `/events/webhooks` (95 files). (4.5, 926bf93)
- Fifteen workers nothing fed, the `internal-events` and `inventory-events` queues, the sales relay pair and the
  forecast and media stubs; `QueueWiringAssertion` refuses a queue without a worker. (4.1, 4.6, 4.7, 4.9)
- Outbox rows nobody consumed (`customer.created`, `customer.deleted`, `StockReserved`); a customer's audit row now
  commits with its create or delete. (4.5)
- Configuration with no reader: `ProcurementFeatureConfig` and its `*_PROCESSOR_DELAY_MS` keys,
  `CRON_SALES_OUTBOX_RELAY`, `QUEUE_TIMEOUT`, `CACHE_SALES_ORDER_TTL_MS`, `CACHE_PRICING_TTL_MS`, `CACHE_INVOICE_TTL_MS`. (926bf93)

#### Fixed
- Media, product-validation, product-identity, import-export, webhook and product-events routes all answered 500
  (they read a `req.shop` nothing set); they now use the verified session and DTOs. (4.1)
- Creating a purchase order rolled itself back; order transitions are compare-and-set (409
  `PURCHASE_ORDER_STATE_CONFLICT`); a purchase return no longer counts itself twice. (4.2)
- The purchase outbox relay marked rows DONE at enqueue, so its worker skipped every event; `Goods*`, `Inspection*` and
  `Outstanding*` events are relayed for the first time. (4.2)
- `POST /ocr/scan-bill` never worked on MySQL (PostgreSQL-only matching) and reported an unreadable answer as an empty
  scan; `confidence` is a real similarity instead of a constant 0.95. (4.4)
- No handler answers 500 any more: barcode search validates `q`, stock-ledger checks answer 404, the purchase draft
  answers 404 or 409, and `POST /storage/backup` works again (archiver pinned to 7.x). (gate)
- `POST /purchase-events/retry/:id` answered success without doing anything; it now resets the FAILED row and resolves
  the dead letter in one transaction. Foreign ids answer 404 on history and galleries. (gate)

#### Security
- Webhooks: MANAGER or above, the secret shown once at creation, URLs checked at registration and at send time (https,
  public addresses, connection pinned), no redirects, signature `t=<ms>,v1=<HMAC-SHA256>`. (4.1, 4.8)
- Ownership checks on media attach, barcode targets and bulk validation; validation results per shop; every BullMQ
  processor runs in its shop's tenant context. (4.1)
- Bill scanning accepts one JPEG, PNG or WebP image up to `OCR_MAX_IMAGE_BYTES` with its bytes checked, is MANAGER or
  above, and sends the API key in a header, not the URL. (4.4)

### Phase 3: Money and stock correctness (3.1 to 3.13)

#### Added
- `SupplierPayablesService`: goods receipts raise `Supplier.pendingPayables`, purchase returns lower it, and supplier
  and vendor-bill payments create an idempotent `SupplierPayment` posted DR ACCOUNTS_PAYABLE / CR CASH or BANK. (3.11)
- Migration hygiene: CI fails when an applied migration changes (`apps/api/scripts/check-migrations-immutable.sh`),
  the ledger triggers ship as `20260929090200`, and the boot drift message points at `prisma/MIGRATIONS.md`. (3.12)

#### Changed
- A refund posts to the sale's shift while it is open and usable by the actor, otherwise to the actor's own; returns
  and cancellations work on soft-deleted products and customers; the web return preview settles like the API. (3.4 to 3.6)
- Reservations need a bounded expiry and positive quantities; `POST /reservations/:id/cancel` and `/release` free the
  stock once. (3.8)
- New indexes on `Product(updatedAt)`, `ProductEventLog`, `SearchHistory`, `AuditLog` and
  `PurchaseReturnLine(grnLineId)`. (3.13)

#### Removed
- The `setup-triggers.ts` script and the `db:push` script. (3.12)

#### Fixed
- Returns are cumulative per line, never rounded per document, and settled against the sale (capped at what remains),
  so partial returns can no longer refund more than was paid. (3.1 to 3.3)
- Proportional allocation never gives a negative share; documents under ₹0.50 settle as cash and keep revenue and GST
  entries non-negative (`splitRevenue`). (3.1 to 3.3)
- Ledger amounts widened (`amount` DECIMAL(14,2), `balanceAfter` DECIMAL(18,2)), closing the running-balance
  overflow (audit P1-2); `InvoiceItem.returnedQuantity` is recomputed from completed returns. (3.1 to 3.3)
- Stock: one idempotency key per receipt and return line, a reservation release never takes `reserved` below 0,
  `variantId` reaches the engine, and reconciliation logs its corrections. (3.7 to 3.9)
- Soft-delete unique keys are enforceable through a NOT NULL `deletedToken` on products, variants, categories,
  suppliers, customers, procurement documents, warehouses and locations; a duplicate answers 409. (3.10)

#### Security
- `creditLimit` is accepted from MANAGER or above only, with an audit row in the same transaction. (3.4)
- A cashier's discount authority checks the combined effective percentage, and a cashier's custom line is capped by
  `BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT`. (3.5, 3.6)
- Stock counts are never auto-approved: the delta comes from the counted variance, the approver differs from the
  requester, and approval and posting run in one transaction. (3.9)

### Phase 2: Authentication, sessions and infrastructure (2.1 to 2.14)

#### Added
- `EmailService` (nodemailer over `SMTP_URL`): without SMTP it logs the message, and production refuses to issue an
  invitation (503). (2.8)

#### Changed
- `NODE_ENV` is required and the start scripts pin it; boot refusals throw, so the reason reaches stderr;
  `FRONTEND_URL` must be a list of origins and `PORT` 1 to 65535. (2.4, 2.5)
- Configuration parsing is strict: booleans are read literally ("false" had become true), numbers refuse garbage, and
  bounds live on the classes. (2.1, 2.10)
- The cache is a Keyv Redis store: keys `cache:<key>` with a TTL, shared by every instance, store errors read as misses.
  (2.11)
- BullMQ connects from `REDIS_URL` (TLS, credentials, database index), and the shared Redis client is closed on
  shutdown. (2.12)
- Correlation ids are sanitised once and appear on guard 401s too; logs are one JSON line per entry with cycle- and
  depth-safe redaction. (2.14)

#### Removed
- `JWT_REFRESH_SECRET`: refresh tokens are opaque and stored hashed. (2.3)
- `cache-manager-redis-yet` (cache-manager 7 ignored it and kept an unbounded in-process Map), `@nestjs/bull` and
  `bull` (their last processor ignored `REDIS_URL`). (2.11, 2.12)

#### Fixed
- A long User-Agent failed login; a malformed refresh body answered 500 instead of 400; passwords are capped at 72
  characters, the bcrypt limit. (2.7)

#### Security
- Rate limiting was effectively off: windows were set in seconds while the throttler counts milliseconds (login allowed
  20 attempts per 10 ms). Credential routes now carry `@AuthThrottle()` with the `AUTH_RATE_LIMIT_*` limits. (2.1)
- Rate-limit counters live in Redis and are shared by every instance; `TRUST_PROXY` decides whether `X-Forwarded-For`
  counts, and the web forwards the browser's address on sign-in and refresh. (2.1)
- Lockout counts failures atomically, clears an expired lock and blocks only new logins (knowing an email no longer
  logs every device out); `AUTH_RATE_LIMIT_ACCOUNT_LIMIT` caps attempts per email. (2.2)
- Production refuses a weak or placeholder `JWT_SECRET`; HS256 is pinned everywhere; a production web server refuses a
  missing or placeholder `NEXTAUTH_SECRET`. (2.3)
- `AUTH_DISABLED` is accepted only under `NODE_ENV=development` or `test`, and `apps/api/.env.development` no longer
  sets it (use an untracked `.env.local`). (2.4)
- Sessions are refresh-token families: each refresh rotates the token in one transaction, reuse of a consumed token
  ends every session of the account, and lifetimes are validated ("12h" used to mean 12 days). (2.6)
- Access tokens carry the session id and last 15 minutes, so `POST /auth/logout` (new), `DELETE /auth/sessions/:id`
  and web sign-out take effect at once (`20260928150000_refresh_token_families`). (2.6)
- `PATCH /users/:id/suspend` and `DELETE /users/:id` no longer return the password hash or lock counters. (2.7)
- Invitations: the invited role must rank below the inviter's, the issuer is recorded (`20260928170000`), a MANAGER
  revokes only their own, and the token is only emailed and works once. (2.8)
- Google sign-in sends only the ID token, and the API never links a Google identity to an account created another
  way (409). (2.9)
- The `/inventory` socket.io namespace accepted any connection; every namespace now authenticates and joins the shop's
  room. (2.13)

### Phase 1: Authorization and shop isolation (1.1 to 1.8)

#### Added
- Locked global sweeps `BatchExpirySweep` (`CRON_BATCH_EXPIRY_SWEEP`, hourly) and `ReservationExpirySweep`
  (`CRON_RESERVATION_EXPIRY_SWEEP`, every minute), each shop in its own context and a failing shop skipped. (1.7)
- `test/integration/tenant-isolation.integration-spec.ts` sends shop B's ids to every id-taking write route as shop A.
  (1.4 to 1.6)

#### Changed
- Migration `20260927180000_scope_line_tables_by_shop` adds `shopId` to the procurement line tables (backfilled from
  the parent); the `BatchStock` unique key includes the shop. (1.6)

#### Fixed
- `POST /batches/sweep-expiry` updated every shop's batches and `POST /reservations/sweep` stopped at the first foreign
  reservation; both act on the caller's shop, one reservation per transaction. (1.7)

#### Security
- `RolesGuard` is deny-by-default: every POST, PUT, PATCH and DELETE handler declares `@Roles(...)`,
  `@AnyAuthenticated()` or `@Public()`, or the API refuses to boot; such handlers used to be open to any signed-in user. (1.1)
- The 83 write handlers without a role check now have one (`src/auth/role-sets.ts`); the creator of a purchase order
  or goods receipt, or the requester of a stock-count adjustment, cannot approve it. (1.2)
- `PATCH /shops/me` writes only the profile columns, so users, products, owner or status cannot ride in on the body;
  every request body is a class-validator DTO. (1.3)
- Shop isolation is derived from the schema: every model with a `shopId` (193 of 227 at the time, previously a hand-kept list of 16) is
  scoped in filters, creates, updates and nested writes; code outside a request declares its tenant context. (1.4)
- Every write that stores an id from the request checks that it belongs to the caller's shop in the same transaction
  (`assertOwned`; 404 otherwise). (1.5)
- `TenantGuard` admits only ACTIVE shops; SUSPENDED and ARCHIVED shops used to pass. (1.8)

### Phase 0: CI and test safety net (0.1 to 0.6)

#### Added
- `.github/workflows/ci.yml` on every push: build and type-check, lint, unit tests, integration suites on MySQL 8 and
  Redis after `migrate deploy` with a `migrate diff` drift check, and Playwright against the compiled API. (0.1)
- `CRON_ENABLED` (default true) switches every scheduler off; `hydrateFromEnv` reads only `@EnvVariable` properties,
  keeps the default for a blank value, accepts 0 and refuses invalid input at boot. (0.3)
- Security regression suite `apps/api/test/security` (`npm run test:security`): each open audit finding (16 tests at
  the start) is an `it.failing` test that breaks the build once fixed, until it is flipped to `it`. (0.6)

#### Changed
- Hermetic integration runs: the test Redis database is flushed first, crons are off, and `bootApp()` waits for every
  BullMQ connection. (0.3)
- Turbo caches `dist/**` and builds dependencies first, so a clean clone builds; root `lint`, `type-check` and `test`
  run through turbo; Node 22 is pinned in `.nvmrc` and every `engines` field. (0.1, 0.5)
- API lint goes from 132 errors to 0, and `no-floating-promises` is enforced again (duplicate rule keys had switched it
  off). (0.4)

#### Fixed
- `CronConfig` ignored every `CRON_*` variable and `CacheConfig` accepted garbage; a cron expression with no upcoming
  run is refused at boot instead of crashing a worker's bootstrap. (0.3)
- `npm run test:e2e` could not resolve its stub; it is now CI's boot regression step, and the scaffold
  `test/app.e2e-spec.ts`, which could never pass, is deleted. (0.2)

### EXEC-005: dashboard certification (September 2026)

#### Added
- `GET /dashboard/insights` (today against the 7-day forecast, restock suggestions from 30-day net sales, top earner)
  and `GET /dashboard/low-stock`, with matching cards and a Low Stock tab on the inventory page. (645a432)
- `docs/DASHBOARD_CERTIFICATION.md`, contract §6, an integration suite that checks every figure against SQL, and a
  Playwright suite for loading, error, partial-failure and polling states. (645a432)

#### Changed
- `GET /dashboard/summary` loads its sections independently: a failed one is listed in `failedSections` with null
  figures (503 `DASHBOARD_UNAVAILABLE` only when all fail), and the web marks only those cards. (645a432)
- Stock alerts count only active, stock-tracked products; payment modes are net of refunds and add up to net sales;
  the KPI cache is dropped after every sale, return and cancellation. (645a432)
- Each card has its own loading, empty, error and stale state; requests time out after 15 s, a malformed answer is an
  error and never zeros, and polls never overlap. (645a432)

#### Fixed
- BullMQ ignored the database index in `REDIS_URL`, so a running development API consumed the test suite's jobs. (645a432)

### EXEC-001 to EXEC-006C: build, database and POS billing integrity (July to September 2026)

#### Added
- `packages/invoice-math` (`@dukaanai/invoice-math`): the one money engine (`InvoiceMathEngine.calculate`) for the API
  and the web preview (POS-MATH-001 to 004, `CALCULATION_SPEC.md`), bound by `docs/POS_BILLING_CONTRACT.md`. (634d42d, 6e6c5b5)
- invoice-math 2.0.0: tender settlement (cash with change, UPI, card, bank transfer, credit, split), preview mode,
  exact proportional discount allocation, cess, strict GST slabs, return math, storage-column limits. (6e6c5b5, 5a7d02c)
- `InventoryMutationEngine`, the single writer of stock (POS-INV-002). (1e0fbc9)
- Shifts (open, close, current, list) feeding expected cash; partial and full returns, same-day cancellation, and
  invoice list, detail and receipt routes and pages. (6e6c5b5)
- Customers: paginated list, credit limit and state, locked idempotent repayments posted to the ledger, ledger and
  invoice pages. (6e6c5b5)
- Custom (ad-hoc) lines (`InvoiceItem.productId` null, `isCustom`): priced by the engine, never stocked, returnable,
  reported, and marked in cart, history and receipts. (5a7d02c)
- Rebuilt POS: GST breakdown, quantity edit, line discounts, customer typeahead with inter-state GST, tender panel
  (change, split, credit), HID scanner, hotkeys, held carts, receipt print, shift banner. (6e6c5b5)
- `LedgerPosting` header with a unique `(shopId, sourceType, sourceId)`, so every sale, return, cancellation,
  repayment, receipt and adjustment posts once, even when sent concurrently. (76f6ab5)
- Integration suites on real MySQL and Redis (failure injection at 16 checkpoints, up to 200 parallel checkouts,
  Redis outage, accounting), a Playwright checkout and `docs/POS_CORRECTNESS_EVIDENCE.md`. (5a7d02c)

#### Changed
- Checkout is one transaction: gapless numbers, shift and customer row locks, tender rows, a balanced double-entry
  ledger with COGS and GST; an idempotency key replays the same request and refuses a different body. (6e6c5b5)
- One lock order for sales, returns, cancellations and repayments (invoice, shift, customer, sequence, products before
  any line insert, ledger balances); deadlocks and lock waits are retried. (5a7d02c)
- Validation runs before any lock; cashiers bill on their own shift; discounts above
  `BILLING_CASHIER_MAX_DISCOUNT_PERCENT` carry a manager's approval; only a manager overrides a credit limit. (5a7d02c, 6e6c5b5)
- Inventory uses real Location ids, checks on hand minus reserved in SQL, moves legacy `currentStock` into the ledger
  on first touch and has a real unique key (`variantKey`); purchase returns now deduct. (6e6c5b5, 5a7d02c)
- `LedgerPostingService` lives in a global `LedgerModule`; goods receipts, purchase returns and adjustments post
  INVENTORY against ACCOUNTS_PAYABLE or INVENTORY_ADJUSTMENT. (5a7d02c)
- Dashboard and reports count sales net of returns on the shop's business day and stream CSV exports; search finds
  SKUs and barcodes; error answers carry a machine `code` and `details`. (6e6c5b5)
- Migrations reproduce `schema.prisma` exactly (`20260919090500_schema_sync`); EXEC-001 entrypoint, EXEC-002 build
  reproducibility, EXEC-003/003B migration recovery and drift, EXEC-004A production Redis. (412440f, 5a7d02c)
- Purchase-domain tax unified and pricing-simulation figures corrected; module resolution and package exports fixed,
  dead code pruned. (f006a39, e6f7762)
- Development: the web serves on port 3010 (the API stays on 3002); the development templates turned the bypass on
  (no longer for the API since 2.4). (4fe6813, 27914c7)

#### Fixed
- The POS checkout could not complete: sales wrote stock to a Location that never existed, product search crashed, cash
  refunds needed shifts nothing could open, and the second sale in a session had no idempotency key. (6e6c5b5)
- Outbox: case-sensitive event families (`LIKE BINARY`), the system-events worker in a tenant context, a cross-tenant
  webhook leak closed, and an event failing its last attempt marked FAILED instead of lost behind DONE. (6e6c5b5, 59426d3)
- The stock cache could be poisoned, and the stock repair could overwrite a concurrent checkout (now a
  compare-and-swap on `stockVersion`). (6e6c5b5, 59426d3)
- The analytics CSV counted draft and cancelled invoices; a concurrent duplicate repayment answered 500; deleting a
  customer could race a credit sale. (59426d3)
- `20260919090000_pos_correctness_foundation` failed on MySQL 8 (error 1137); stock-count adjustments moved stock the
  wrong way. (76f6ab5, 5a7d02c)

### Before the roadmap: sign-in, live data and configuration (July 2026)

#### Added
- Web sign-in with NextAuth (credentials and Google), a register page (name, shop, email, password; signs in on
  success) and route protection; API `POST /api/auth/google` with `User.googleId`. (8c85029; tightened in 2.9)
- API endpoints for suppliers, expenses (new `Expense` model) and notifications; `GET /dashboard/analytics` (KPIs with
  profit from item cost, revenue trend, payment modes, category sales, top customers). (8817a3a)
- `GET` and `PATCH /shops/me` for the shop profile; customer detail with recent invoices and udhaar transactions;
  customer payments through `POST /customers/:id/payments`. (3a113d7)
- Typed configuration domains validated with class-validator (`EnterpriseConfigModule`, ENV-2.1 and ENV-2.2) and
  committed `.env.development`, `.env.production` and `.env.test` templates. (993adf7, a969182, c935a87, 954ea34, 4b731b9)
- `AUTH_DISABLED` (API) and `NEXT_PUBLIC_AUTH_DISABLED` (web), off by default: requests then run as the provisioned
  OWNER `system@dukaanai.local`; an unrecognised value refuses to boot. (055a979, a2c6af0; dev and test only since 2.4)
- Domain modules from the epic 2 and 3 work (inventory, procurement, sales, customers; no commit descriptions), later
  secured, repaired or removed by phases 1 to 4. (d88103d, 33c04e4, f632fc4, 4147b31, 5747b21, 816a57e)
- Audit reports (`full_codebase_audit.md`, `docs/audits/*`) and planning notes (`plan.md`, `IMPLEMENTATION_PLAN.md`,
  `teach.md`). (2da5bc6, 9a5c567, 527ffa8, 492658f, 5b1d0d7)

#### Changed
- Web pages read live API data (products, customers, dashboard, billing, inventory, suppliers, employees, expenses,
  notifications, analytics) and name the request that failed; recent transactions get "View all". (5b1d0d7, fdfc1d8, 3a113d7, 9c300f8, 4e7198a)
- `GET /dashboard/trends` computes revenue from invoices (the `DailySalesAggregation` table was empty); the web reads
  udhaar from `outstandingBalance` (it showed 0). (8817a3a, 3a113d7)

#### Fixed
- Every product create answered 500; web checkout posted without the `/api` prefix (404); customer create answered 500.
  (2cf6d0a, 71651f6)
- The API did not boot (a storage circular import left `S3_CLIENT` undefined, and the config registry found 0
  domains); boot errors now reach stderr. (055a979)
- A missing, expired or revoked refresh token threw a TypeError instead of answering 401; the API build works on
  Windows. (a4abc57, 5188fdf)

### Corrections to the v1.0.0-rc1 and v1.0.0-rc2 entries

No longer true:

- rc2, "CacheModule ... via `cache-manager-redis-yet`": cache-manager 7 ignored that wiring (it reads `stores`), so the
  cache was an unbounded per-process Map; 52522c0 (2.11) replaced it with a Keyv Redis store and removed the package.
- rc2, "Billing RBAC ... `@UseGuards(RolesGuard)` to `BillingController`": the guards run once globally since 69868fd
  (5.7) and no controller declares them; the billing write roles now include OWNER, which the rc2 list lacked.
- rc2, "WebSocket Auth: Added JWT verification to `InventoryGateway`": the gateway checks no token (it carries the
  socket throttle and role guards); `AuthenticatedIoAdapter` authenticates every connection, and 52522c0 (2.13) found
  the `/inventory` namespace open to any connection until then.
- rc2, "Ledger Immutability Triggers ... `20260612000000_add_ledger_fk_and_triggers` ... No manual trigger setup
  required": 9c300f8 removed that migration (replaced by `20260717185000_schema_baseline`, which has no triggers);
  `setup-triggers.ts` installed them until a46635d (3.12) shipped `20260929090200`, recreated by b6a8398 (7.7).
- rc2, "Migration Completeness ... three previously empty migration directories": removed in 9c300f8 and archived in
  `apps/api/prisma/legacy-migrations-before-baseline-20260717.tar.gz`; `apps/api/SCHEMA_RECOVERY.md` says that chain
  did not reproduce the schema. The chain matches `schema.prisma` since `20260919090500_schema_sync` (5a7d02c).
- rc1, "Transactional Outbox Engine" and "Dead Letter Queue": the relays marked rows DONE at enqueue, so an event that
  exhausted its retries was lost (59426d3) and the purchase worker skipped every event (757cdbb); since a85be54 (4.7)
  rows are claimed and settled by the worker, and FAILED rows are retried with `POST /sales/events/retry`.

Still true, but changed since:

- rc1, "Inventory Reconciliation": it now checks `currentStock` against the stock ledger first (compare-and-swap
  repair; 6e6c5b5, 59426d3), then Redis, and visits only products updated in its lookback window, by keyset (5.4).
- rc1, "Redis operates as graceful fallback": between 2.11 and 9.18 a Redis outage hung sales, dashboard loads and the
  metrics scrape; 4dd9e1b (9.18) restored the fallback.
- rc1, "Frontend Idempotency ... Key cleared only on success": 6e6c5b5 found that the second sale in a session had no
  key; keys are per checkout, and the hook waits for the cart store to hydrate (6.5).
- rc2, "PII Redaction ... handle arrays": the redactor could recurse forever on a cyclic object; 52522c0 (2.14) made it
  cycle- and depth-safe, with one JSON line per entry.
- rc2, "Prisma Logging": outside production every query was logged regardless of `PRISMA_LOG_QUERIES` until 69868fd (5.8).
- rc2, "Documentation: Corrected false claims in ... DEPLOYMENT_CHECKLIST.md": the checklist was corrected again in
  6ac6f75 (7.3) and e6f4c58 (8.6); its smoke step expected "exactly 2 entries" instead of a balanced `LedgerPosting`.
- rc1, "Stabilized `billing-concurrency.spec.ts`": the spec was deleted in 6e6c5b5; concurrency is covered by the
  integration suites of 5a7d02c (up to 200 parallel checkouts).

## [v1.0.0-rc2] - 2026-06-20

_Never tagged in git. Some statements below were wrong when written or are no longer true: see the corrections under v1.0.0-rc3._

### Fixed (Production Hardening)
- **Database Integrity:** Removed `relationMode = "prisma"` from schema. MySQL now enforces all foreign keys natively.
- **Migration Completeness:** Wrote valid `migration.sql` for three previously empty migration directories (`add_stock_constraints`, `add_ledger_fk_and_triggers`, `add_drift_log`). Fresh `prisma migrate deploy` now succeeds.
- **Ledger Immutability Triggers:** Moved `prevent_ledger_update` and `prevent_ledger_delete` triggers into Prisma migration SQL (`20260612000000_add_ledger_fk_and_triggers/migration.sql`). No manual trigger setup required.
- **Ledger Accounting:** Added `LedgerAccount` enum (`CASH`, `ACCOUNTS_RECEIVABLE`, `SALES_REVENUE`, etc.) and `LedgerEntryType` enum. Ledger entries now use typed `account` field instead of description strings. `balanceAfter` is computed from actual running balance, not hardcoded to 0.
- **CacheModule:** Wired `CacheModule` to Redis via `cache-manager-redis-yet` with `REDIS_URL` configuration. Falls back to in-memory for local development without Redis.
- **Security — Billing RBAC:** Added `@Roles(ADMIN, SUPER_ADMIN, MANAGER, CASHIER)` and `@UseGuards(RolesGuard)` to `BillingController`. VIEWER role is now blocked from creating invoices.
- **Security — WebSocket Auth:** Added JWT verification to `InventoryGateway`. Unauthenticated connections are rejected. Shop membership is validated.
- **CORS:** Added `x-correlation-id` to allowed headers for browser-to-API distributed tracing.
- **PII Redaction:** Fixed `CorrelationLogger.redact()` to handle arrays (previously skipped). Added `authorization` and `creditcard` to sensitive keys.
- **Prisma Logging:** Disabled SQL query logging in production (`NODE_ENV=production`) to eliminate performance overhead and log noise.
- **Worker:** Removed duplicate single-entry ledger creation from `SystemEventsProcessor` (BillingService already creates proper double-entry inside the transaction). Fixed `SYSTEM_WORKER` userId to use actual userId from job payload.
- **Schema:** Made `idempotencyKey` non-nullable on Invoice model.
- **Documentation:** Corrected false claims in PRODUCTION_FREEZE.md, CHANGELOG.md, and DEPLOYMENT_CHECKLIST.md.

## [v1.0.0-rc1] - 2026-06-12

_Never tagged in git. Some statements below were wrong when written or are no longer true: see the corrections under v1.0.0-rc3._

### Added
- **Transactional Outbox Engine:** `OutboxEvent` created inside `BillingService`'s Prisma transaction. `OutboxRelayService` sweeps pending events via `SELECT FOR UPDATE SKIP LOCKED` into BullMQ.
- **Consumer Idempotency:** `SystemEventsProcessor` checks `AuditLog` for prior processing before committing, ensuring exactly-once processing.
- **Dead Letter Queue (DLQ):** Transient failures use exponential backoff; permanent errors throw `UnrecoverableError` to skip retries.
- **Redlock Distributed Cron Locking:** `CronLockService` uses `ioredis` Redlock to coordinate single-instance cron execution across pods.
- **Inventory Reconciliation:** `InventoryReconService` auto-syncs MySQL baseline against Redis every 5 minutes with batch processing (1000 products/batch).
- **Inventory Drift Logging:** Detects Redis/MySQL desync events and logs them to `InventoryDriftLog` table with `DETECTED`/`REPAIRED`/`FAILED` status tracking.
- **Frontend Idempotency:** `useIdempotencyKey.ts` uses `sessionStorage` and UUID v4 for multi-tab safety. Key cleared only on success.
- **Correlation ID Middleware:** `AsyncLocalStorage`-based request tracing via `x-correlation-id` header.
- **CorrelationLogger:** Extends NestJS `ConsoleLogger` with ambient `correlationId` injection and PII redaction.

### Changed
- Refactored `BillingService` to execute all operations (stock, invoice, items, inventory logs, shift, udhar, audit, outbox, ledger) atomically in one `$transaction`.
- Redis operates as graceful fallback — application continues on MySQL-only path during Redis outages.

### Fixed
- Stabilized `billing-concurrency.spec.ts` with dynamically seeded unique test data.

[Unreleased]: https://github.com/shoryabansalgithub/DukanAi-real/compare/v1.0.0-rc3...HEAD
[v1.0.0-rc3]: https://github.com/shoryabansalgithub/DukanAi-real/releases/tag/v1.0.0-rc3
