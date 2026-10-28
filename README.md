# DukaanAI

Point of sale and back office for small Indian retail shops: GST invoices and
returns, customer credit (udhar), shifts and cash drawers, products and stock,
expenses, suppliers, dashboards, and a reconciliation of every business day.
One API serves many shops (multi-tenant), a web app runs the counter and the
back office.

**Status:** release candidate `v1.0.0-rc3`. The engineering roadmap
(phases 0 to 9) is built and certified on every release tag; the go-live gate
(staging, the pilot in a real shop, the external penetration test, the owner's
sign-off) is open: [`docs/GO_LIVE.md`](./docs/GO_LIVE.md).

## What is built

**API** (`apps/api`, NestJS): POS billing (sales, cumulative returns,
cancellations, repayments; one database transaction each, idempotent),
shifts and drawers, customers and udhar, products, variants, categories and
search, batches and expiry, reservations, stock counts, warehouses, a
double-entry ledger, dashboards and CSV exports, nightly analytics and
reorder recommendations, the nightly financial reconciliation, OCR bill
scanning (Google Gemini), product media, bulk imports for onboarding, signed
webhooks, notifications, staff invitations, password reset by email,
sessions with rotating refresh tokens, Prometheus metrics, health probes and
a graceful shutdown. Procurement (purchase orders, goods receipts, vendor
bills, purchase returns, credit notes) exists in the API only; keep it
paused with `FEATURE_PROCUREMENT_ENABLED=false` until the open findings of
the 2026-10-11 audit on it are fixed (`docs/SUPPORT.md`, feature pause).

**Web** (`apps/web`, Next.js): sign-in, registration (and joining a shop by
invitation), password reset, dashboard, billing (POS, barcode scanner,
receipts), invoices, customers, products, inventory (batches and expiry, low
stock), suppliers, expenses, shifts, employees, notifications, analytics,
the AI bill scanner, Smart Capture and settings. Every action calls the
API; there is no mock data.
The same server answers the public marketing site (landing page, features,
guides, FAQ, alternatives, glossary) with a sitemap, robots.txt, Open Graph
cards, JSON-LD and `llms.txt` / Markdown twins for AI agents; `SITE_URL` and
`SITE_INDEXABLE` configure it (`docs/DEPLOYMENT.md`).

**Not built:** voice billing, WhatsApp messaging, an AI chat assistant,
variant-level POS pricing, tax-inclusive pricing, coupons, FIFO or
weighted-average costing, a web screen for procurement.

## Stack

| Part | What |
|---|---|
| API | Node.js 22, NestJS 11, Prisma 6.19 on MySQL 8, BullMQ and a Keyv cache on Redis 7, Socket.IO, prom-client, Sentry (optional) |
| Web | Next.js 16 (App Router, Turbopack) on React 19, NextAuth 4, Tailwind CSS, Zustand, Recharts, Framer Motion |
| Money | `packages/invoice-math`: the one invoice and return engine, shared by the API and the web (`CALCULATION_SPEC.md` there) |
| Tests | Jest (unit, integration against real MySQL and Redis, security, boot regression), Playwright (browser), promtool, artillery (load) |
| Delivery | Docker images built once per commit by `.github/workflows/release.yml` after CI passed, Docker Compose or Kubernetes, Caddy at the edge, Prometheus / Alertmanager / Loki / Grafana |

## Repository layout

```
apps/api/                 NestJS API: src/, prisma/ (schema, migrations, MIGRATIONS.md), test/, load/
apps/web/                 Next.js web app: src/app (pages), src/components, src/lib, e2e*/ (Playwright)
packages/invoice-math/    the shared invoice engine (build it before the apps: they import its dist/)
deploy/                   edge (Caddy), Kubernetes, Prometheus rules, Alertmanager, Grafana, db-ops image
scripts/                  backups and restore drills, compose smokes, certification, release checks, drills
docs/                     everything an operator, a support person or a developer needs (map below)
docker-compose.yml        the reference stack (everything bundled, local)
docker-compose.prod.yml   the production variant (managed MySQL and Redis, HTTPS edge, backup agent)
```

## Run it with Docker (the reference stack)

Needs Docker with Compose 2.24.4 or newer.

```bash
cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/; s/^NEXTAUTH_SECRET=.*/NEXTAUTH_SECRET=$(openssl rand -hex 32)/; s/^GRAFANA_ADMIN_PASSWORD=.*/GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 24)/" .env
docker compose up --build -d --wait
```

Open <http://localhost:3000>, register a shop (the owner's password needs
12 or more characters and must not be a common one), then fill in the shop
profile under Settings (state and GSTIN: counter sales are billed CGST + SGST in
the shop's state). `docker compose down` stops
it; add `-v` to delete the data. The monitoring stack is
`docker compose --profile ops up -d prometheus alertmanager blackbox loki alloy grafana`
(Grafana on <http://127.0.0.1:3001>). Details: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Run it for development

Prerequisites: Node.js 22 (`nvm use` reads `.nvmrc`), MySQL 8 (or MariaDB
10.11) and Redis 7.

The committed `apps/api/.env.development` and `apps/web/.env.development`
already describe a local setup: MySQL at `localhost:3306` as `root` /
`password` with a database `dukaanai`, Redis at `localhost:6379`, the API on
port 3002, the web on port 3010. Put only what differs on your machine in
`apps/api/.env.local` / `apps/web/.env.local` (git-ignored; they win over the
templates). Do not copy an `.env.example` there: it would override every
development default.

```bash
npm ci                                   # from the repository root
npm run build -w @dukaanai/invoice-math  # the apps import its dist/

# The database (create it first: CREATE DATABASE dukaanai CHARACTER SET utf8mb4;)
cd apps/api
DATABASE_URL=mysql://root:password@localhost:3306/dukaanai npx prisma migrate deploy
cd ../..
```

Then choose how you sign in:

- **Real sign-in:** `echo NEXT_PUBLIC_AUTH_DISABLED=false >> apps/web/.env.local`,
  and register a shop at <http://localhost:3010/register>.
- **No sign-in (development only):** `echo AUTH_DISABLED=true >> apps/api/.env.local`.
  The web template already sets `NEXT_PUBLIC_AUTH_DISABLED=true`; every
  request then runs as a provisioned system user (`system@dukaanai.local`,
  OWNER of its own shop). Both builds and the API refuse the flag in
  production. Set both flags the same way.

```bash
npm run dev    # turbo: the API (nest start --watch, port 3002) and the web (next dev, port 3010)
```

The API answers on <http://localhost:3002/api> (`/api/health`, Swagger at
`/api/docs` outside production) and the web on <http://localhost:3010>.

After every `git pull` that brings a migration, run the `migrate deploy`
above again: the API refuses to start while a migration of the checkout is
not applied, and prints which (`SCHEMA DRIFT DETECTED`). Never use
`prisma db push`; failed or edited migrations: `apps/api/prisma/MIGRATIONS.md`.
After changing `schema.prisma` or switching branches, `npx prisma generate`.

## Tests

From the repository root:

```bash
npm run type-check     # every workspace
npm run lint
npm test               # unit tests: invoice-math and the API
npm run build
```

API suites (`cd apps/api`):

```bash
npm test                                   # unit (src/**/*.spec.ts)
DATABASE_URL=mysql://root:password@localhost:3306/dukaanai_test npx prisma migrate deploy
npm run test:integration                   # real MySQL + Redis from .env.test (database dukaanai_test, Redis db 1)
npm run test:security                      # the security regression suite alone
npm run build && npm run test:e2e          # the boot regression of the built entrypoint
```

`TEST_DATABASE_URL` / `TEST_REDIS_URL` point the integration suites
elsewhere. Web browser tests (`cd apps/web`):
`npx playwright install chromium`, then `npm run test:e2e` (with the auth
bypass) and `npm run test:e2e:auth` (real sign-in). CI
(`.github/workflows/ci.yml`) runs all of it, the integration suites on MySQL
8.0 and 8.4, plus the compose smokes, the backup drills, gitleaks and the
dependency audit.

## Documentation

Release and operations:
- [`RELEASE.md`](./RELEASE.md): versions, tagging, certification, staging, rollback
- [`DEPLOYMENT_CHECKLIST.md`](./DEPLOYMENT_CHECKLIST.md): the go-live order for one release
- [`docs/GO_LIVE.md`](./docs/GO_LIVE.md): the go-live gate and who signs what
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md): topology, images, environment, compose, Kubernetes, the edge, monitoring access
- [`docs/STAGING.md`](./docs/STAGING.md): staging, promotion, deploying by digest
- [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) and [`docs/RUNBOOKS.md`](./docs/RUNBOOKS.md): logs, metrics, alerts, one page per alert
- [`docs/BACKUP_RESTORE.md`](./docs/BACKUP_RESTORE.md) and [`docs/DATA_SAFETY.md`](./docs/DATA_SAFETY.md): backups, restore drills, recovery objectives
- [`docs/SECRETS.md`](./docs/SECRETS.md): every secret, its owner and rotation
- [`docs/DRILLS.md`](./docs/DRILLS.md), [`docs/BUSINESS_DAY.md`](./docs/BUSINESS_DAY.md), [`docs/PRODUCTION_LIMITS.md`](./docs/PRODUCTION_LIMITS.md), [`docs/LOAD_TEST_BASELINE.md`](./docs/LOAD_TEST_BASELINE.md): the evidence behind the limits
- [`ENVIRONMENT_REQUIREMENTS.md`](./ENVIRONMENT_REQUIREMENTS.md): what the infrastructure must provide

Product and support:
- [`docs/guides/`](./docs/guides): the cashier's and the owner's guides, the FAQ
- [`docs/SUPPORT.md`](./docs/SUPPORT.md), [`docs/ONBOARDING.md`](./docs/ONBOARDING.md), [`docs/PILOT.md`](./docs/PILOT.md)
- [`docs/privacy/`](./docs/privacy), [`docs/compliance/GST_INVOICE_CHECK.md`](./docs/compliance/GST_INVOICE_CHECK.md), [`docs/security/`](./docs/security)

Engineering:
- [`AGENTS.md`](./AGENTS.md): architecture decisions and sharp edges, roadmap row by row
- [`docs/POS_BILLING_CONTRACT.md`](./docs/POS_BILLING_CONTRACT.md): the binding API and engine contract
- [`apps/api/prisma/MIGRATIONS.md`](./apps/api/prisma/MIGRATIONS.md): migrations and rollbacks
- [`docs/architecture/environment-architecture.md`](./docs/architecture/environment-architecture.md): how configuration is loaded and validated; every API variable is in `apps/api/.env.example`
- [`CHANGELOG.md`](./CHANGELOG.md)

Historical (kept for the record, superseded by the documents above; each
says so at the top): `TECH_STACK_ARCHITECTURE.md`, `PROJECT_ANALYSIS_REPORT.md`,
`full_codebase_audit.md`, `plan.md`, `teach.md`, `PHASE2_SUMMARY.md`,
`FEATURES_GUIDE.md`, `FILE_INDEX.md`, `IMPLEMENTATION_PLAN.md`,
`SETUP_GUIDE.md`, `ROADMAP.md`, `PROJECT_STRUCTURE.md`, `docs/audits/`.

## License

Proprietary.
