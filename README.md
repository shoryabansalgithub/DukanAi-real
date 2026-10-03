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

- Node.js 20 LTS
- MySQL 8+
- Redis 6.2+
- Google OAuth web-client credentials (only when Google sign-in is enabled)

### Installation

```bash
# Install dependencies from the repository root
npm install

# Create local environment files from the committed templates
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# Apply database migrations, then start API and web in separate terminals
cd apps/api && npx prisma migrate deploy && npm run start:dev
cd apps/web && npm run dev
```

The API listens on `http://localhost:3001/api`; the web app listens on `http://localhost:3002` when started with its configured port. See [ENVIRONMENT_REQUIREMENTS.md](./ENVIRONMENT_REQUIREMENTS.md) and [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) before deploying.

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

## 📋 Development Phases

### ✅ PHASE 1: Tech Stack Architecture
- [x] Proposed production-grade tech stack
- [x] Architectural decisions with reasoning
- [x] Scalability strategy
- [x] Folder structure

### ✅ PHASE 2: UI Implementation (CURRENT)
- [x] Project scaffolding with Next.js
- [x] Tailwind CSS setup
- [x] Component library (shadcn/ui style)
- [x] Reusable components
- [x] Dashboard page
- [x] Navigation (Sidebar + Navbar)
- [x] Mock data
- [x] Charts & visualizations
- [x] Professional styling
- [x] Responsive design
- [x] Dark mode ready

### ✅ Backend & authentication

- [x] NestJS API and Prisma schema
- [x] Credentials and Google OAuth authentication
- [x] Server-side Google ID-token verification and rotating refresh tokens
- [x] Tenant-scoped REST API endpoints and WebSocket authentication
- [x] HMAC-signed webhook delivery with audit records

### 🤖 PHASE 4: AI Features (After Backend)
- [ ] AI Assistant chat
- [ ] Voice billing
- [ ] OCR invoice scanning
- [ ] Predictive analytics
- [ ] Smart recommendations

### 🔧 PHASE 5: Production Optimization
- [ ] Performance optimization
- [ ] Redis caching
- [x] Docker containerization (`docker compose up`, see docs/DEPLOYMENT.md)
- [ ] CI/CD pipeline
- [ ] Security hardening
- [x] Monitoring setup (`/api/metrics`, alert rules, error tracking: see docs/OBSERVABILITY.md)

## 🎨 UI Components

### Available Components

**UI Elements:**
- Button (primary, secondary, outline, ghost, danger)
- Card (with header, footer, content)
- Badge (colored variants)
- Input (with validation)

**Dashboard Components:**
- StatCard (metrics with trends)
- DataTable (sortable, filterable)
- Charts (Sales, Bar, Pie - using Recharts)

**Navigation:**
- Sidebar (collapsible, responsive)
- Navbar (theme toggle, notifications, profile)

## 🎯 Features Implemented (Phase 2)

### Dashboard Page ✅
- Key metrics (Sales, Profit, Udhar, Stock)
- Sales trend chart
- Category distribution pie chart
- AI Business Insights
- Top customers list
- Recent transactions table

### Navigation ✅
- Responsive sidebar
- Top navbar with theme toggle
- Active route highlighting
- Mobile hamburger menu

### Pages Created ✅
- Dashboard (complete demo)
- Billing (POS) - placeholder
- Customers - placeholder
- Inventory - placeholder
- Analytics - placeholder
- AI Assistant - placeholder
- Database Manager - placeholder
- Settings - placeholder

## 🔄 Mock Data

Pre-configured mock data for development:
- Dashboard statistics
- Sales data (weekly trends)
- Products (7 items)
- Customers (5 items)
- Transactions (4 items)
- Category breakdown
- Payment modes

Located in: `src/data/mockData.ts`

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
- [Component Library](./docs/COMPONENTS.md) - Coming soon
- [API Documentation](./docs/API.md) - Coming soon
- [Database Schema](./docs/DATABASE.md) - Coming soon

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
