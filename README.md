# DukaanAI - AI-Powered Retail Operating System

> **Status**: Active full-stack application. The web and API applications build successfully; deployment still requires provisioned MySQL, Redis, and Google OAuth credentials.

A world-class, enterprise-grade AI-powered retail operating system designed for small to medium-sized businesses. Built with cutting-edge technologies for scalability, performance, and user experience.

## 🎯 Project Overview

DukaanAI is a comprehensive retail OS that combines:

- **AI Voice Billing** - Voice-activated point-of-sale
- **Smart Inventory** - Real-time stock management
- **Customer Udhar** - Credit/tab tracking system
- **Analytics** - Predictive business insights
- **Multi-Shop Support** - Enterprise multi-tenant architecture
- **WhatsApp Integration** - Direct customer communication
- **OCR Invoice Scanner** - Automated invoice processing

## 🏗️ Architecture

### Tech Stack

**Frontend:**
- Next.js 14+ (App Router)
- TypeScript
- Tailwind CSS
- shadcn/ui components
- Framer Motion (animations)
- Recharts (charts)
- Zustand (state management)

**Backend:**
- NestJS (production-grade Node.js)
- MySQL (PlanetScale)
- Prisma ORM
- Redis (caching)
- Socket.IO (real-time)

**AI & ML:**
- FastAPI (Python microservices)
- OpenAI API (LLM)
- Langchain (prompt engineering)
- Tesseract OCR

**Search & Analytics:**
- MeiliSearch → Elasticsearch (search)
- Prometheus + Grafana (monitoring)
- Sentry (error tracking)

See [TECH_STACK_ARCHITECTURE.md](./TECH_STACK_ARCHITECTURE.md) for detailed architecture documentation.

## 📁 Project Structure

```
DukaanAI/
├── apps/
│   ├── web/                    # Next.js frontend and NextAuth integration
│       ├── src/
│       │   ├── app/           # App Router pages
│       │   ├── components/    # Reusable UI components
│       │   ├── lib/           # Utilities & helpers
│       │   ├── hooks/         # Custom React hooks
│       │   ├── store/         # Zustand state
│       │   ├── types/         # TypeScript types
│       │   └── data/          # Mock data
│       └── package.json
│   └── api/                    # NestJS API, Prisma schema, workers, and domain modules
├── TECH_STACK_ARCHITECTURE.md
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js 22 (`.nvmrc`; the `engines` floor is 22.12)
- MySQL 8+
- Redis 6.2+
- Google OAuth web-client credentials (only when Google sign-in is enabled)

### Installation

```bash
# Install dependencies from the repository root
npm install

# Local overrides (secrets, your DATABASE_URL) go in the git-ignored .env.local;
# the committed .env.development templates supply every other default.
cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local

# Apply database migrations, then start API and web in separate terminals
# (the start scripts pin NODE_ENV=development, so the .env.development templates apply)
cd apps/api && npx prisma migrate deploy && npm run start:dev
cd apps/web && npm run dev
```

The API listens on `http://localhost:3002/api` (`PORT`) and the web app on `http://localhost:3010` (`next dev -p 3010`; `FRONTEND_URL` and `NEXTAUTH_URL` in the development templates match). Every API variable is documented in `apps/api/.env.example`; see [ENVIRONMENT_REQUIREMENTS.md](./ENVIRONMENT_REQUIREMENTS.md) and [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) before deploying.

### Keeping the database schema in sync

The Prisma schema evolves with the code. If your local database was created
from an older checkout, API endpoints that touch new tables/columns will fail
with Prisma `P2021` (missing table) or `P2022` (missing column) errors - the
API now detects this at boot with a schema probe, logs a loud
`SCHEMA DRIFT DETECTED` error, and refuses to start. The fix is always:

```bash
cd apps/api && npx prisma migrate deploy
```

Run it after every `git pull` that adds a migration (make sure `DATABASE_URL`
in your environment points at your local database). Never `prisma db push`:
it bypasses the migration history, and the ledger triggers and data fixes
only ship as migrations. A failed or edited migration is settled with
`prisma migrate resolve`; see `apps/api/prisma/MIGRATIONS.md`.

### Seeding demo data

An idempotent seed populates a realistic Indian retail dataset (shop products,
customers with udhaar balances, suppliers, employees, expenses, notifications,
and a month of invoices) so every page has real backend data:

```bash
# API must be running (it validates the real write paths via HTTP)
cd apps/api && npm run seed
```

The script creates entities through the public API where endpoints exist and
falls back to Prisma for the rest. Re-running it is safe - existing records
are detected and skipped. In auth-bypass mode the data lands in the system
shop; with real auth enabled it logs in as (or registers) the demo account
`demo@dukaan.local` / `Demo@1234` and seeds that shop instead.

### Verification

```bash
npm run type-check
npm test --workspace=api -- --runInBand
npm run build --workspace=api
npm run build --workspace=dukaanai-web
```

### Disabling authentication (development / demo only)

Authentication can be switched off behind an explicit, reversible flag. It is
OFF by default: when the variables are unset, empty, or anything other than an
explicit truthy value (`true`, `1`, `yes`, `on`), normal login is required. An
unrecognized value makes the API refuse to boot rather than guess.

- API: set `AUTH_DISABLED=true` in the API environment. Every request then runs
  as a provisioned system user (`system@dukaanai.local`, role OWNER, own shop),
  and the API logs a loud `AUTH DISABLED` warning at startup. The real auth code
  paths (including Google account provisioning and token verification) remain
  intact - the flag only gates access, it never accepts unverified identity.
- Web: set `NEXT_PUBLIC_AUTH_DISABLED=true` in the web environment. The login
  gate is skipped and the app loads directly. The value is inlined at build
  time, so for production builds it must be set before `next build`.

Set both flags together, and never enable them for a production deployment.

## 📋 What is built

The production-readiness roadmap (phases 0–8: authorization, tenant
isolation, money and stock correctness, scaffolding repair, denial of
service, web correctness, dependencies and deployment, observability and
backups, data model, scripts, config and docs) is complete; `AGENTS.md`
records every row with the files and tests that prove it, and
`docs/POS_BILLING_CONTRACT.md` is the binding API contract.

**API (NestJS, `apps/api`)**: POS billing (sales, cumulative returns,
cancellations, repayments, one transaction each), shifts, customers and
udhar, products, variants, categories, search, batches and expiry,
reservations, stock counts, procurement (purchase orders → goods receipts →
vendor bills → payments, purchase returns, credit notes), warehouses, a
double-entry ledger, dashboards and CSV exports, nightly ABC/XYZ analytics
and reorder recommendations, OCR bill scanning (Gemini), product media and
imports, signed webhooks, notifications, staff invitations, sessions with
rotating refresh tokens, Prometheus metrics, health probes and graceful
shutdown.

**Web (Next.js 16, `apps/web`)**: login, register (invitation join), forgot
and reset password, dashboard, billing (POS), invoices and receipts,
customers, products, inventory (batches, low stock), suppliers, expenses,
shifts, employees, notifications, analytics, AI scanner, smart capture and
settings. Every mutating action calls the API; there is no mock data.

**Not built**: an AI assistant, voice billing, variant-level POS pricing,
tax-inclusive pricing, coupons, weighted-average or FIFO costing.

## 🎨 Design System

### Colors
- **Primary**: Deep Purple (#7c3aed)
- **Success**: Green (#10b981)
- **Warning**: Amber (#f59e0b)
- **Danger**: Red (#ef4444)
- **Background**: Light/Dark mode support

### Typography
- **Headings**: Bold, large sizes
- **Body**: Clear, readable
- **Labels**: Small, semibold

### Spacing
- Consistent 8px grid
- Generous padding/margins
- Proper visual hierarchy

## Deployment

Use the checklist in [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md). Google OAuth must be configured with the exact callback URL `https://YOUR_WEB_ORIGIN/api/auth/callback/google`; set the matching `GOOGLE_CLIENT_ID` in both applications and enable it in the web environment.

## 📚 Documentation

- [Tech Stack Architecture](./TECH_STACK_ARCHITECTURE.md) - Detailed tech decisions
- [Deployment](./docs/DEPLOYMENT.md) - Images, probes, shutdown, compose from a fresh clone
- [Observability](./docs/OBSERVABILITY.md) - JSON logs, `/api/metrics`, error tracking, alert runbook
- [Backups and restore](./docs/BACKUP_RESTORE.md) - MySQL 8 backup, restore, the rehearsed drill
- [Data safety](./docs/DATA_SAFETY.md) - recovery objectives (RPO / RTO) per store, the data inventory, measured restore times, open gaps, the owner's sign-off
- [POS / Billing API contract](./docs/POS_BILLING_CONTRACT.md) - the binding route, payload and consistency contract
- [Environment architecture](./docs/architecture/environment-architecture.md) - env files, loading order, validation, queues; every API variable is in `apps/api/.env.example`
- [Migrations runbook](./apps/api/prisma/MIGRATIONS.md) - `migrate deploy` / `migrate resolve`, rolling back a release
- [Agent notes](./AGENTS.md) - architecture decisions and sharp edges, row by row

## 🤝 Contributing

This is a professional project. Follow these guidelines:
1. Use TypeScript everywhere
2. Follow component naming conventions
3. Write reusable components
4. Add proper documentation
5. Test responsive design

## 📄 License

Proprietary - DukaanAI

## 👨‍💼 Architecture by

Senior Full-Stack Engineer | SaaS Architect | AI Systems Developer

Built for enterprise-grade scalability and production-ready performance.
